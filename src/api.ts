import crypto, { generateKeyPairSync } from "crypto";
import fs from "fs/promises";
import { NodeSSH } from "node-ssh";
import path from "path";
import ignore from "ignore";

import {
  ImageType,
  InstanceExecResponse,
  InstanceGetOptions,
  InstanceHttpService,
  InstanceListOptions,
  InstanceNetworking,
  InstanceRefs,
  InstanceSnapshotOptions,
  InstanceStartOptions,
  InstanceStatus,
  InstanceStopOptions,
  InstanceType,
  MorphCloudClientOptions,
  MorphCloudClientType,
  ResourceSpec,
  SnapshotCreateOptions,
  SnapshotGetOptions,
  SnapshotListOptions,
  SnapshotRefs,
  SnapshotStatus,
  SnapshotType,
  SyncOptions,
} from "./types";

const MORPH_BASE_URL = "https://cloud.morph.so/api";
const MORPH_SSH_HOSTNAME = "ssh.cloud.morph.so";
const MORPH_SSH_PORT = 22;

const DEFAULT_IMAGE = "morphvm-minimal";
const DEFAULT_VCPUS = 2;
const DEFAULT_MEMORY = 1024;
const DEFAULT_DISK_SIZE = 1024;

const SSH_TEMP_KEYPAIR = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
  privateKeyEncoding: {
    type: "pkcs1",
    format: "pem",
  },
});

interface SFTPError extends Error {
  code?: string | number;
}

class Image implements ImageType {
  readonly id: string;
  readonly object: "image";
  readonly name: string;
  readonly description?: string;
  readonly diskSize: number;
  readonly created: number;

  constructor(data: any) {
    this.id = data.id;
    this.object = data.object;
    this.name = data.name;
    this.description = data.description;
    this.diskSize = data.disk_size;
    this.created = data.created;
  }
}

class Snapshot implements SnapshotType {
  readonly id: string;
  readonly object: "snapshot";
  readonly created: number;
  readonly status: SnapshotStatus;
  readonly spec: ResourceSpec;
  readonly refs: SnapshotRefs;
  readonly digest?: string;
  metadata?: Record<string, string>;
  private client: MorphCloudClient;

  constructor(data: any, client: MorphCloudClient) {
    this.id = data.id;
    this.object = data.object;
    this.created = data.created;
    this.status = data.status as SnapshotStatus;
    this.spec = {
      vcpus: data.spec.vcpus,
      memory: data.spec.memory,
      diskSize: data.spec.disk_size,
    };
    this.refs = {
      imageId: data.refs.image_id,
    };
    this.digest = data.digest;

    if (data.metadata) {
      this.metadata = { ...data.metadata };
    } else {
      this.metadata = {};
    }

    this.client = client;
  }

  /**
   * Delete the snapshot
   */
  async delete(): Promise<void> {
    await this.client.DELETE(`/snapshot/${this.id}`);
  }

  /**
   * Computes a chain hash based on the parent's chain hash and an effect identifier.
   * The effect identifier is typically derived from the function name and its arguments.
   * @param parentChainHash The parent's chain hash
   * @param effectIdentifier A string identifier for the effect being applied
   * @returns A new hash that combines the parent hash and the effect
   */
  static computeChainHash(
    parentChainHash: string,
    effectIdentifier: string
  ): string {
    const hasher = crypto.createHash("sha256");
    hasher.update(parentChainHash);
    hasher.update("\n");
    hasher.update(effectIdentifier);
    return hasher.digest("hex");
  }

  /**
   * Runs a command on an instance and streams the output
   * @param instance The instance to run the command on
   * @param command The command to run
   * @param getPty Whether to allocate a PTY
   */
  private async _runCommandEffect(
    instance: InstanceType,
    command: string,
    getPty: boolean = true
  ): Promise<void> {
    const ssh = await instance.ssh();

    try {
      // Execute the command and capture output
      const { code } = await ssh.execCommand(command, {
        cwd: "/",
        onStdout: (chunk: Buffer) => {
          process.stdout.write(chunk.toString("utf8"));
        },
        onStderr: (chunk: Buffer) => {
          process.stderr.write(chunk.toString("utf8"));
        },
        // Set up PTY if requested
        ...(getPty ? { pty: true } : {}),
      });

      if (code !== 0 && code !== null) {
        console.warn(`⚠️ ERROR: Command (${command}) exited with code ${code}`);
        throw new Error(`Command exited with code ${code}`);
      }
    } catch (error) {
      console.error(`Error executing command: ${error}`);
      throw error;
    } finally {
      ssh.dispose();
    }
  }

  /**
   * Generic caching mechanism based on a "chain hash".
   * - Computes a unique hash from the parent's chain hash, the function name,
   *   and string representations of args and kwargs.
   * - If a snapshot already exists with that chain hash, returns it.
   * - Otherwise, starts an instance from this snapshot, applies the function,
   *   snapshots the instance, updates its metadata with the new chain hash,
   *   and returns the new snapshot.
   *
   * @param fn The effect function to apply
   * @param args Arguments to pass to the effect function
   * @returns A new (or cached) Snapshot with the updated chain hash
   */
  private async _cacheEffect<T extends any[]>(
    fn: (instance: InstanceType, ...args: T) => Promise<void>,
    ...args: T
  ): Promise<SnapshotType> {
    const parentChainHash = this.digest || this.id;
    const effectIdentifier = fn.name + JSON.stringify(args);

    const newChainHash = Snapshot.computeChainHash(
      parentChainHash,
      effectIdentifier
    );

    const candidates = await this.client.snapshots.list({
      digest: newChainHash,
    });

    if (candidates.length > 0) {
      if (this.client.verbose) {
        console.log(`✅ [CACHED] ${args}`);
      }
      return candidates[0];
    }

    if (this.client.verbose) {
      console.log(`🚀 [RUN] ${args}`);
    }
    const instance = await this.client.instances.start({ snapshotId: this.id }); // Ensure start returns InstanceType

    try {
      await instance.waitUntilReady(300);
      await fn(instance, ...args);
      const newSnapshot = await instance.snapshot({ digest: newChainHash }); // Ensure snapshot returns SnapshotType

      return newSnapshot;
    } finally {
      await instance.stop();
    }
  }

  /**
   * Run a command (with getPty=true, in the foreground) on top of this snapshot.
   * Returns a new snapshot that includes the modifications from that command.
   * Uses _cacheEffect(...) to avoid rebuilding if an identical effect (command) was applied before.
   *
   * @param command The shell command to run
   * @returns A new snapshot with the command applied
   */
  async setup(command: string): Promise<SnapshotType> {
    return this._cacheEffect(
      async (instance: InstanceType, cmd: string, pty: boolean) => {
        await this._runCommandEffect(instance, cmd, pty);
      },
      command,
      true
    );
  }

  /**
   * Sets metadata for the snapshot
   * @param metadata Metadata key-value pairs to set
   */
  async setMetadata(metadata: Record<string, string>): Promise<void> {
    const metadataObj = metadata || {};

    // Send the update to the API
    await this.client.POST(`/snapshot/${this.id}/metadata`, {}, metadataObj);

    // Update the local metadata
    if (!this.metadata) {
      this.metadata = {};
    }

    Object.entries(metadataObj).forEach(([key, value]) => {
      this.metadata![key] = value;
    });
  }
}

class Instance implements InstanceType {
  readonly id: string;
  readonly object: "instance";
  readonly created: number;
  status: InstanceStatus;
  readonly spec: ResourceSpec;
  readonly refs: InstanceRefs;
  networking: InstanceNetworking;
  readonly metadata?: Record<string, string>;
  private client: MorphCloudClient;

  constructor(data: any, client: MorphCloudClient) {
    this.id = data.id;
    this.object = data.object;
    this.created = data.created;
    this.status = data.status as InstanceStatus;
    this.spec = {
      vcpus: data.spec.vcpus,
      memory: data.spec.memory,
      diskSize: data.spec.disk_size,
    };
    this.refs = {
      snapshotId: data.refs.snapshot_id,
      imageId: data.refs.image_id,
    };
    this.networking = {
      internalIp: data.networking.internal_ip,
      httpServices: data.networking.http_services as InstanceHttpService[],
    };
    this.metadata = data.metadata;
    this.client = client;
  }

  async stop(): Promise<void> {
    await this.client.instances.stop({ instanceId: this.id });
  }

  async pause(): Promise<void> {
    await this.client.POST(`/instance/${this.id}/pause`);
    await this.refresh();
  }

  async resume(): Promise<void> {
    await this.client.POST(`/instance/${this.id}/resume`);
    await this.refresh();
  }

  async setMetadata(metadata: Record<string, string>): Promise<void> {
    await this.client.POST(`/instance/${this.id}/metadata`, {}, metadata);
    await this.refresh();
  }

  async snapshot(options: InstanceSnapshotOptions = {}): Promise<SnapshotType> {
    const digest = options.digest || undefined;
    const metadata = options.metadata || {};

    const response = await this.client.POST(
      `/instance/${this.id}/snapshot`,
      { digest },
      { metadata }
    );

    return new Snapshot(response, this.client);
  }

  async branch(count: number): Promise<{
    snapshot: SnapshotType;
    instances: InstanceType[];
  }> {
    const response = await this.client.POST(
      `/instance/${this.id}/branch`,
      { count },
      {}
    );
    const snapshot = new Snapshot(response.snapshot, this.client);
    const instances = response.instances.map(
      (i: any) => new Instance(i, this.client)
    );
    return { snapshot, instances };
  }

  async exposeHttpService(
    name: string,
    port: number,
    auth_mode?: string
  ): Promise<InstanceHttpService> {
    const payload: any = { name, port };
    if (auth_mode !== undefined) {
      payload.auth_mode = auth_mode;
    }

    await this.client.POST(`/instance/${this.id}/http`, {}, payload);
    await this.refresh();

    let service = this.networking.httpServices.find(
      (service) => service.name === name
    );
    if (service === undefined) {
      throw new Error("Failed to expose HTTP service");
    }
    return service;
  }

  async hideHttpService(name: string): Promise<void> {
    await this.client.DELETE(`/instance/${this.id}/http/${name}`);
    await this.refresh();
  }

  async exec(command: string | string[]): Promise<InstanceExecResponse> {
    const cmd = typeof command === "string" ? [command] : command;
    const response = await this.client.POST(
      `/instance/${this.id}/exec`,
      {},
      { command: cmd }
    );
    return response as InstanceExecResponse; // Cast if necessary
  }

  async waitUntilReady(timeout?: number): Promise<void> {
    const startTime = Date.now();
    while (this.status !== InstanceStatus.READY) {
      // Use imported enum
      if (timeout && Date.now() - startTime > timeout * 1000) {
        throw new Error("Instance did not become ready before timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await this.refresh();
      if (this.status === InstanceStatus.ERROR) {
        // Use imported enum
        throw new Error("Instance encountered an error");
      }
    }
  }

  async ssh(): Promise<NodeSSH> {
    const ssh = new NodeSSH();
    return await ssh.connect({
      host: process.env.MORPH_SSH_HOSTNAME || MORPH_SSH_HOSTNAME,
      port: process.env.MORPH_SSH_PORT
        ? parseInt(process.env.MORPH_SSH_PORT)
        : MORPH_SSH_PORT,
      username: `${this.id}:${this.client.apiKey}`,
      privateKey: SSH_TEMP_KEYPAIR.privateKey,
    });
  }

  async sync(
    source: string,
    dest: string,
    options: SyncOptions = {}
  ): Promise<void> {
    interface FileInfo {
      size: number;
      mtime: number;
    }

    const log = (level: "info" | "debug" | "error", message: string) => {
      if (options.verbose || level === "error") {
        console.log(`[${level.toUpperCase()}] ${message}`);
      }
    };

    const getGitignore = async (dirPath: string): Promise<any> => {
      try {
        const gitignorePath = path.join(dirPath, ".gitignore");
        const content = await fs.readFile(gitignorePath, "utf8");
        return ignore().add(content);
      } catch (error) {
        return null;
      }
    };

    const shouldIgnore = (
      filePath: string,
      baseDir: string,
      ignoreRule: any
    ): boolean => {
      if (!ignoreRule) return false;
      const relativePath = path.relative(baseDir, filePath);
      return ignoreRule.ignores(relativePath);
    };

    const parseInstancePath = (path: string): [string | null, string] => {
      const match = path.match(/^([^:]+):(.+)$/);
      return match ? [match[1], match[2]] : [null, path];
    };

    const formatSize = (size: number): string => {
      const units = ["B", "KB", "MB", "GB"];
      let formatted = size;
      let unitIndex = 0;
      while (formatted >= 1024 && unitIndex < units.length - 1) {
        formatted /= 1024;
        unitIndex++;
      }
      return `${formatted.toFixed(1)}${units[unitIndex]}`;
    };

    // Get instance paths
    const [sourceInstance, sourceDirPath] = parseInstancePath(source);
    const [destInstance, destDirPath] = parseInstancePath(dest);

    // Validate paths
    if (
      (sourceInstance && destInstance) ||
      (!sourceInstance && !destInstance)
    ) {
      throw new Error(
        "One (and only one) path must be a remote path in the format instance_id:/path"
      );
    }

    // Validate instance ID matches
    const instanceId = sourceInstance || destInstance;
    if (instanceId !== this.id) {
      throw new Error(
        `Instance ID in path (${instanceId}) doesn't match this instance (${this.id})`
      );
    }

    log("info", `Starting sync operation from ${source} to ${dest}`);
    log(
      "info",
      options.dryRun
        ? "[DRY RUN] "
        : "" + `Syncing ${sourceInstance ? "from" : "to"} remote...`
    );

    // Connect SSH
    const ssh = await this.ssh();
    const sftp = await ssh.requestSFTP();

    // Promisify SFTP methods
    const promisifiedSftp = {
      list: (path: string): Promise<any[]> => {
        return new Promise((resolve, reject) => {
          sftp.readdir(path, (err, list) => {
            if (err) reject(err);
            else resolve(list);
          });
        });
      },
      stat: (path: string): Promise<any> => {
        return new Promise((resolve, reject) => {
          sftp.stat(path, (err, stats) => {
            if (err) reject(err);
            else resolve(stats);
          });
        });
      },
      mkdir: (path: string): Promise<void> => {
        return new Promise((resolve, reject) => {
          sftp.mkdir(path, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      fastPut: (src: string, dest: string): Promise<void> => {
        return new Promise((resolve, reject) => {
          sftp.fastPut(src, dest, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      fastGet: (src: string, dest: string): Promise<void> => {
        return new Promise((resolve, reject) => {
          sftp.fastGet(src, dest, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      utimes: (path: string, atime: number, mtime: number): Promise<void> => {
        return new Promise((resolve, reject) => {
          sftp.utimes(path, atime, mtime, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      unlink: (path: string): Promise<void> => {
        return new Promise((resolve, reject) => {
          sftp.unlink(path, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
    };

    try {
      const getRemoteFiles = async (
        dir: string
      ): Promise<Map<string, FileInfo>> => {
        const files = new Map<string, FileInfo>();

        const readDir = async (currentDir: string) => {
          try {
            const list = await promisifiedSftp.list(currentDir);
            for (const item of list) {
              const fullPath = `${currentDir}/${item.filename}`;
              if (item.attrs.isDirectory()) {
                await readDir(fullPath);
              } else {
                files.set(fullPath, {
                  size: item.attrs.size,
                  mtime: item.attrs.mtime,
                });
              }
            }
          } catch (error) {
            const sftpError = error as SFTPError;
            if (sftpError.code !== "ENOENT" && sftpError.code !== 2) {
              throw error;
            }
          }
        };

        await readDir(dir);
        return files;
      };

      // Update getLocalFiles to use gitignore
      const getLocalFiles = async (
        dir: string
      ): Promise<Map<string, FileInfo>> => {
        const files = new Map<string, FileInfo>();

        const ignoreRule = options.respectGitignore
          ? await getGitignore(dir)
          : null;

        const readDir = async (currentDir: string) => {
          try {
            const items = await fs.readdir(currentDir, { withFileTypes: true });
            for (const item of items) {
              const fullPath = path.join(currentDir, item.name);

              // Skip if path matches gitignore patterns
              if (
                options.respectGitignore &&
                shouldIgnore(fullPath, dir, ignoreRule)
              ) {
                log("debug", `Ignoring file (gitignore): ${fullPath}`);
                continue;
              }

              if (item.isDirectory()) {
                await readDir(fullPath);
              } else {
                const stat = await fs.stat(fullPath);
                files.set(fullPath, {
                  size: stat.size,
                  mtime: stat.mtimeMs / 1000,
                });
              }
            }
          } catch (error: any) {
            // Catch any error
            if (error.code !== "ENOENT") {
              throw error;
            }
          }
        };

        await readDir(dir);
        return files;
      };

      const mkdirRemote = async (dir: string) => {
        if (!dir || dir === "/") return;

        const parts = dir.split("/").filter(Boolean);
        let current = "";

        for (const part of parts) {
          current += "/" + part;
          try {
            await promisifiedSftp.stat(current);
          } catch (error) {
            const sftpError = error as SFTPError;
            // Check for ENOENT (file not found) - code might be string or number
            if (sftpError.code === "ENOENT" || sftpError.code === 2) {
              try {
                await promisifiedSftp.mkdir(current);
                log("debug", `Created remote directory: ${current}`);
              } catch (mkdirError: unknown) {
                const err = mkdirError as SFTPError;
                // Check for EEXIST (file exists) - code might be string or number
                if (err.code !== "EEXIST" && err.code !== 4) {
                  throw mkdirError; // Re-throw if it's not an "already exists" error
                }
                log(
                  "debug",
                  `Directory already exists or created concurrently: ${current}`
                );
              }
            } else {
              // Re-throw other stat errors
              throw error;
            }
          }
        }
      };

      const syncToRemote = async (localDir: string, remoteDir: string) => {
        await mkdirRemote(remoteDir);

        log("info", "Scanning directories...");
        const localFiles = await getLocalFiles(localDir);
        const remoteFiles = await getRemoteFiles(remoteDir);

        const changes: Array<{
          type: "copy" | "delete";
          source?: string;
          dest: string;
          size?: number;
        }> = [];
        const synced = new Set<string>();

        for (const [localPath, localInfo] of localFiles.entries()) {
          const relativePath = path.relative(localDir, localPath);
          const remotePath = `${remoteDir}/${relativePath}`.replace(/\\/g, "/");
          const remoteInfo = remoteFiles.get(remotePath);

          if (
            !remoteInfo ||
            remoteInfo.size !== localInfo.size ||
            Math.abs(remoteInfo.mtime - localInfo.mtime) >= 1 // Allow small diffs
          ) {
            changes.push({
              type: "copy",
              source: localPath,
              dest: remotePath,
              size: localInfo.size,
            });
          }
          synced.add(remotePath);
        }

        if (options.delete) {
          for (const [remotePath] of remoteFiles) {
            if (!synced.has(remotePath)) {
              changes.push({
                type: "delete",
                dest: remotePath,
              });
            }
          }
        }

        log("info", "\nChanges to be made:");
        log(
          "info",
          `  Copy: ${changes.filter((c) => c.type === "copy").length} files (${formatSize(changes.reduce((sum, c) => sum + (c.size || 0), 0))})`
        );
        if (options.delete) {
          log(
            "info",
            `  Delete: ${changes.filter((c) => c.type === "delete").length} files`
          );
        }

        if (changes.length === 0) {
          log("info", "  No changes needed");
          return;
        }

        if (options.dryRun) {
          log("info", "\nDry run - no changes made");
          for (const change of changes) {
            if (change.type === "copy") {
              log(
                "info",
                `  Would copy: ${change.dest} (${formatSize(change.size!)})`
              );
            } else {
              log("info", `  Would delete: ${change.dest}`);
            }
          }
          return;
        }

        // Execute changes
        for (const change of changes) {
          try {
            if (change.type === "copy") {
              const targetDir = path.dirname(change.dest);
              // No need to log 'Ensuring directory exists' as mkdirRemote handles it
              await mkdirRemote(targetDir);

              log("info", `Copying ${change.dest}`);
              await promisifiedSftp.fastPut(change.source!, change.dest);

              // Update mtime
              const stat = await fs.stat(change.source!);
              await promisifiedSftp.utimes(
                change.dest,
                stat.mtimeMs / 1000, // atime
                stat.mtimeMs / 1000 // mtime
              );
            } else {
              log("info", `Deleting ${change.dest}`);
              // Ignore errors during deletion (e.g., file already gone)
              await promisifiedSftp.unlink(change.dest).catch(() => {});
            }
          } catch (error) {
            const sftpError = error as SFTPError;
            log(
              "error",
              `Error processing ${change.dest}: ${sftpError.message} (code: ${sftpError.code})`
            );
            // Decide whether to continue or re-throw
            // For now, re-throw to stop the sync on error
            throw error;
          }
        }
      };

      const syncFromRemote = async (remoteDir: string, localDir: string) => {
        await fs.mkdir(localDir, { recursive: true });

        log("info", "Scanning directories...");
        const remoteFiles = await getRemoteFiles(remoteDir);
        const localFiles = await getLocalFiles(localDir);

        const changes: Array<{
          type: "copy" | "delete";
          source?: string;
          dest: string;
          size?: number;
        }> = [];
        const synced = new Set<string>();

        for (const [remotePath, remoteInfo] of remoteFiles.entries()) {
          const relativePath = path.relative(remoteDir, remotePath);
          const localPath = path.join(localDir, relativePath);
          const localInfo = localFiles.get(localPath);

          if (
            !localInfo ||
            localInfo.size !== remoteInfo.size ||
            Math.abs(localInfo.mtime - remoteInfo.mtime) >= 1 // Allow small diffs
          ) {
            changes.push({
              type: "copy",
              source: remotePath,
              dest: localPath,
              size: remoteInfo.size,
            });
          }
          synced.add(localPath);
        }

        if (options.delete) {
          for (const [localPath] of localFiles) {
            if (!synced.has(localPath)) {
              changes.push({
                type: "delete",
                dest: localPath,
              });
            }
          }
        }

        log("info", "\nChanges to be made:");
        log(
          "info",
          `  Copy: ${changes.filter((c) => c.type === "copy").length} files (${formatSize(changes.reduce((sum, c) => sum + (c.size || 0), 0))})`
        );
        if (options.delete) {
          log(
            "info",
            `  Delete: ${changes.filter((c) => c.type === "delete").length} files`
          );
        }

        if (changes.length === 0) {
          log("info", "  No changes needed");
          return;
        }

        if (options.dryRun) {
          log("info", "\nDry run - no changes made");
          for (const change of changes) {
            if (change.type === "copy") {
              log(
                "info",
                `  Would copy: ${change.dest} (${formatSize(change.size!)})`
              );
            } else {
              log("info", `  Would delete: ${change.dest}`);
            }
          }
          return;
        }

        for (const change of changes) {
          try {
            if (change.type === "copy") {
              log("info", `Copying ${change.dest}`);
              await fs.mkdir(path.dirname(change.dest), { recursive: true });
              await promisifiedSftp.fastGet(change.source!, change.dest);

              // Get mtime from remote file *after* download
              const stat = await promisifiedSftp.stat(change.source!);
              await fs.utimes(change.dest, stat.mtime, stat.mtime); // Use remote mtime for both atime/mtime
            } else {
              log("info", `Deleting ${change.dest}`);
              try {
                await fs.unlink(change.dest);
              } catch (error: any) {
                // Ignore errors if file doesn't exist locally
                if (error.code !== "ENOENT") {
                  throw error;
                }
              }
            }
          } catch (error) {
            const err = error as Error;
            log("error", `Error processing ${change.dest}: ${err.message}`);
            // Decide whether to continue or re-throw
            throw error;
          }
        }
      };

      if (sourceInstance) {
        await syncFromRemote(sourceDirPath, destDirPath);
      } else {
        await syncToRemote(sourceDirPath, destDirPath);
      }
    } finally {
      ssh.dispose();
    }
  }

  private async refresh(): Promise<void> {
    const instanceData: InstanceType = await this.client.instances.get({
      instanceId: this.id,
    });
    Object.assign(this, instanceData);
  }
}

class MorphCloudClient implements MorphCloudClientType {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly verbose: boolean;

  constructor(options: MorphCloudClientOptions = {}) {
    // Use imported type
    this.apiKey = options.apiKey || process.env.MORPH_API_KEY || "";
    if (!this.apiKey) {
      throw new Error(
        "Morph API key is required. Provide it via options or MORPH_API_KEY environment variable."
      );
    }
    this.baseUrl = options.baseUrl || MORPH_BASE_URL;
    this.verbose = options.verbose || false;
  }

  private async request(
    method: string,
    endpoint: string,
    query?: any,
    data?: any
  ): Promise<any> {
    // Return type can be kept as any or made more specific if possible
    let uri = new URL(this.baseUrl + endpoint);
    if (query) {
      // Filter out undefined/null query params
      const filteredQuery = Object.entries(query)
        .filter(([_, value]) => value !== undefined && value !== null)
        .reduce(
          (obj, [key, value]) => {
            obj[key] = value;
            return obj;
          },
          {} as Record<string, any>
        );
      uri.search = new URLSearchParams(filteredQuery).toString();
    }

    const headers: HeadersInit = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    const response = await fetch(uri.toString(), {
      // Ensure uri is string
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      let errorBody;
      try {
        // Try to parse JSON error first
        errorBody = await response.json();
      } catch {
        // Fallback to text if JSON parsing fails
        errorBody = await response.text();
      }
      // Improve error message
      const errorMessage = `HTTP Error ${response.status} (${response.statusText}) for ${method} ${response.url}`;
      const errorDetails =
        typeof errorBody === "string"
          ? errorBody
          : JSON.stringify(errorBody, null, 2);
      throw new Error(`${errorMessage}\nResponse Body:\n${errorDetails}`);
    }

    // Handle responses with no content (e.g., 204 No Content for DELETE)
    if (
      response.status === 204 ||
      response.headers.get("content-length") === "0"
    ) {
      return {}; // Return an empty object or undefined as appropriate
    }

    try {
      // Assume successful responses are JSON
      return await response.json();
    } catch (error) {
      // This catch block might be less likely now with the checks above, but keep for safety
      throw new Error(
        `Failed to parse JSON response for ${method} ${response.url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async GET(endpoint: string, query?: any): Promise<any> {
    return this.request("GET", endpoint, query);
  }

  async POST(endpoint: string, query?: any, data?: any): Promise<any> {
    return this.request("POST", endpoint, query, data);
  }

  async DELETE(endpoint: string, query?: any): Promise<void> {
    // DELETE often returns no body
    await this.request("DELETE", endpoint, query); // request handles 204 correctly now
  }

  images = {
    list: async (): Promise<ImageType[]> => {
      // Return imported type array
      const response = await this.GET("/image");
      // Ensure the mapping creates objects conforming to ImageType
      return response.data.map((image: any) => new Image(image));
    },
  };

  snapshots = {
    list: async (
      options: SnapshotListOptions = {}
    ): Promise<SnapshotType[]> => {
      // Return imported type array
      // safely build query string
      const { digest, metadata } = options;
      const queryParams: Record<string, string> = {}; // Use Record for easier construction

      // Add digest if provided
      if (digest) {
        queryParams["digest"] = digest;
      }

      // Add metadata in stripe style format: metadata[key]=value
      if (metadata) {
        Object.entries(metadata).forEach(([key, value]) => {
          queryParams[`metadata[${key}]`] = String(value); // Ensure value is string
        });
      }

      const response = await this.GET(`/snapshot`, queryParams); // Pass queryParams directly
      // Ensure the mapping creates objects conforming to SnapshotType
      return response.data.map((snapshot: any) => new Snapshot(snapshot, this));
    },

    create: async (
      options: SnapshotCreateOptions = {}
    ): Promise<SnapshotType> => {
      // Return imported type
      // Convert Map to object if needed - ensure this happens *before* digest creation if metadata is used there
      let requestMetadata = options.metadata;
      if (requestMetadata instanceof Map) {
        requestMetadata = Object.fromEntries(requestMetadata.entries());
      }

      // Helper function for digest creation, using the potentially converted metadata
      const create_digest = (
        opts: SnapshotCreateOptions,
        meta?: Record<string, string>
      ) => {
        const hasher = crypto.createHash("sha256");
        hasher.update(opts.imageId || DEFAULT_IMAGE); // Provide a default if imageId is optional but needed for hash
        hasher.update(String(opts.vcpus || DEFAULT_VCPUS)); // Provide defaults if optional
        hasher.update(String(opts.memory || DEFAULT_MEMORY));
        hasher.update(String(opts.diskSize || DEFAULT_DISK_SIZE));
        // Sort metadata keys to ensure consistent hash
        const currentMetadata = meta || {}; // Use the potentially converted metadata passed in
        if (currentMetadata) {
          Object.keys(currentMetadata)
            .sort()
            .forEach((key) => {
              hasher.update(key);
              hasher.update(currentMetadata[key]); // Assumes metadata values are strings or consistently stringifiable
            });
        }
        return hasher.digest("hex");
      };

      // Pass the potentially converted metadata to create_digest
      const digest = options.digest || create_digest(options, requestMetadata);

      const data = {
        image_id: options.imageId,
        spec: {
          // API might expect spec object
          vcpus: options.vcpus,
          memory: options.memory,
          disk_size: options.diskSize,
        },
        digest: digest, // Use the calculated or provided digest
        metadata: requestMetadata || {},
      };
      const response = await this.POST("/snapshot", {}, data);
      // Ensure the constructor returns an object conforming to SnapshotType
      return new Snapshot(response, this);
    },

    get: async (options: SnapshotGetOptions): Promise<SnapshotType> => {
      // Return imported type
      const response = await this.GET(`/snapshot/${options.snapshotId}`);
      // Ensure the constructor returns an object conforming to SnapshotType
      return new Snapshot(response, this);
    },
  };

  instances = {
    list: async (
      options: InstanceListOptions = {}
    ): Promise<InstanceType[]> => {
      // Return imported type array
      const { metadata } = options;
      const queryParams: Record<string, string> = {};

      // Add metadata in stripe style format: metadata[key]=value
      if (metadata && typeof metadata === "object") {
        Object.entries(metadata).forEach(([key, value]) => {
          queryParams[`metadata[${key}]`] = String(value);
        });
      }

      const response = await this.GET(`/instance`, queryParams);
      // Ensure the mapping creates objects conforming to InstanceType
      return response.data.map((instance: any) => new Instance(instance, this));
    },

    start: async (options: InstanceStartOptions): Promise<InstanceType> => {
      // Return imported type
      const { snapshotId, metadata, ttlSeconds, ttlAction } = options;

      // Build query parameters (only snapshot_id goes here based on previous structure)
      const queryParams = {
        snapshot_id: snapshotId,
      };

      // Build request body
      const body: any = {};
      if (metadata) {
        // Convert Map if necessary
        body.metadata =
          metadata instanceof Map
            ? Object.fromEntries(metadata.entries())
            : metadata;
      }
      if (ttlSeconds !== undefined) {
        body.ttl_seconds = ttlSeconds;
      }
      if (ttlAction) {
        body.ttl_action = ttlAction;
      }

      const response = await this.POST("/instance", queryParams, body);
      // Ensure the constructor returns an object conforming to InstanceType
      return new Instance(response, this);
    },

    get: async (options: InstanceGetOptions): Promise<InstanceType> => {
      // Return imported type
      const response = await this.GET(`/instance/${options.instanceId}`);
      // Ensure the constructor returns an object conforming to InstanceType
      return new Instance(response, this);
    },

    stop: async (options: InstanceStopOptions): Promise<void> => {
      await this.DELETE(`/instance/${options.instanceId}`);
    },
  };
}

export { Image, Instance, MorphCloudClient, Snapshot };
