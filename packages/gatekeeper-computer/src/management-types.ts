export type SandboxRegistration = {
  name: string;
  workspaceId: string;
  createdAt: number;
};

export type ManagedSandboxStatus = {
  state: "ready" | "stopped" | "deleted";
  activeJob: { id: string; kind: string; state: string } | null;
  queuedJobs: number;
};

export type ManagedSandbox = {
  id: string;
  name?: string;
  workspaceId?: string;
  createdAt?: number;
  status: ManagedSandboxStatus | null;
  error?: string;
};

export type ManagementAction = {
  id: string;
  sandboxId: string;
  kind: "stop" | "destroy";
  requestedAt: number;
  completedAt?: number;
  state: "pending" | "completed" | "failed" | "cancelled";
  error?: string;
};

export type SandboxManagementPage = {
  sandboxes: ManagedSandbox[];
  reserved: number;
  limit: number;
  history: ManagementAction[];
};

export interface SandboxManagementApi {
  listSandboxes(): Promise<SandboxManagementPage>;
  stopSandbox(id: string): Promise<ManagementAction>;
  deleteSandbox(id: string): Promise<ManagementAction>;
}
