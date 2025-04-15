export const SnapshotStatus = {
  PENDING: "pending",
  READY: "ready",
  FAILED: "failed",
  DELETING: "deleting",
  DELETED: "deleted",
} as const;

export type SnapshotStatus =
  (typeof SnapshotStatus)[keyof typeof SnapshotStatus];

export const InstanceStatus = {
  PENDING: "pending",
  READY: "ready",
  PAUSED: "paused",
  SAVING: "saving",
  ERROR: "error",
} as const;

export type InstanceStatus =
  (typeof InstanceStatus)[keyof typeof InstanceStatus];

export interface ResourceSpec {
  vcpus: number;
  memory: number;
  diskSize: number;
}

export interface SnapshotRefs {
  imageId: string;
}

export interface InstanceHttpService {
  name: string;
  port: number;
  url: string;
}

export interface InstanceNetworking {
  internalIp?: string;
  httpServices: InstanceHttpService[];
  auth_mode?: string;
}

export interface InstanceRefs {
  snapshotId: string;
  imageId: string;
}

export interface InstanceExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MorphCloudClientOptions {
  apiKey?: string;
  baseUrl?: string;
  verbose?: boolean;
}

export interface SnapshotListOptions {
  digest?: string;
  metadata?: Record<string, string>;
}

export interface SnapshotCreateOptions {
  imageId?: string;
  vcpus?: number;
  memory?: number;
  diskSize?: number;
  digest?: string;
  metadata?: Record<string, string>;
}

export interface SnapshotGetOptions {
  snapshotId: string;
}

export interface InstanceListOptions {
  metadata?: Record<string, string>;
}

export interface InstanceStartOptions {
  snapshotId: string;
  metadata?: Record<string, string>;
  ttlSeconds?: number;
  ttlAction?: "stop" | "pause";
}

export interface InstanceSnapshotOptions {
  digest?: string;
  metadata?: Record<string, string>;
}

export interface InstanceGetOptions {
  instanceId: string;
}

export interface InstanceStopOptions {
  instanceId: string;
}

export interface SyncOptions {
  delete?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  respectGitignore?: boolean;
}

export interface MorphCloudClientType {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly verbose: boolean;
}

export interface ImageType {
  readonly id: string;
  readonly object: "image";
  readonly name: string;
  readonly description?: string;
  readonly diskSize: number;
  readonly created: number;
}

export interface SnapshotType {
  readonly id: string;
  readonly object: "snapshot";
  readonly created: number;
  readonly status: SnapshotStatus;
  readonly spec: ResourceSpec;
  readonly refs: SnapshotRefs;
  readonly digest?: string;
  metadata?: Record<string, string>;
  delete(): Promise<void>;
  setup(command: string): Promise<SnapshotType>;
  setMetadata(metadata: Record<string, string>): Promise<void>;
}

export interface InstanceType {
  readonly id: string;
  readonly object: "instance";
  readonly created: number;
  status: InstanceStatus;
  readonly spec: ResourceSpec;
  readonly refs: InstanceRefs;
  networking: InstanceNetworking;
  readonly metadata?: Record<string, string>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setMetadata(metadata: Record<string, string>): Promise<void>;
  snapshot(options?: InstanceSnapshotOptions): Promise<SnapshotType>;
  branch(
    count: number
  ): Promise<{ snapshot: SnapshotType; instances: InstanceType[] }>;
  exposeHttpService(
    name: string,
    port: number,
    auth_mode?: string
  ): Promise<InstanceHttpService>;
  hideHttpService(name: string): Promise<void>;
  exec(command: string | string[]): Promise<InstanceExecResponse>;
  waitUntilReady(timeout?: number): Promise<void>;
  ssh(): Promise<any>; // Using 'any' for NodeSSH type to avoid server-side import
  sync(source: string, dest: string, options?: SyncOptions): Promise<void>;
}
