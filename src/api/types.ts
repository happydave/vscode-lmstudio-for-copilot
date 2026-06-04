// API type definitions for LM Studio REST API

export interface LmStudioModel {
  type: "llm" | "embedding";
  publisher: string;
  key: string;
  display_name: string;
  architecture: string | null;
  quantization: {
    name: string;
    bits_per_weight: number;
  };
  size_bytes?: number;
  params_string?: string | null;
  max_context_length?: number | null;
  format: "gguf" | "mlx" | null;
  description?: string | null;
  variants?: string[];
  selected_variant?: string;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: {
      allowed_options: string[];
      default: string;
    };
  };
  loaded_instances: LoadedInstance[];
}

export interface LoadedInstance {
  id: string;
  config: LoadedConfig;
}

export interface LoadedConfig {
  context_length: number;
  eval_batch_size?: number;
  parallel?: number;
  flash_attention?: boolean;
  num_experts?: number;
  offload_kv_cache_to_gpu?: boolean;
}

export interface ApiModelsResponse {
  models: LmStudioModel[];
}

export interface LoadModelRequest {
  model: string;
  context_length?: number;
  flash_attention?: boolean;
  offload_kv_cache_to_gpu?: boolean;
  eval_batch_size?: number;
  num_experts?: number;
  temperature?: number;
}

export interface LoadModelResponse {
  type: "llm" | "embedding";
  instance_id: string;
  load_time_seconds: number;
  status: "loaded";
  load_config: Record<string, unknown>;
}

export interface UnloadModelRequest {
  instance_id: string;
}

export interface UnloadModelResponse {
  instance_id: string;
}

export interface ConnectionConfig {
  name: string;
  scheme: "http" | "https";
  host: string;
  port: number;
}

// ============================================================
// Webview Message Protocol Types
// ============================================================

// ── Webview → Extension (inbound messages) ────────────────────

export interface WebviewMessageInit {
  type: 'init';
}

export interface WebviewMessageFetchConnections {
  type: 'fetchConnections';
}

export interface WebviewMessageFetchModels {
  type: 'fetchModels';
  serverName: string;
}

export interface WebviewMessageActiveServerChanged {
  type: 'activeServerChanged';
  serverName: string;
}

export interface WebviewMessageSwitchConnection {
  type: 'switchConnection';
  name: string;
}

export interface WebviewMessageTestConnection {
  type: 'testConnection';
  config: ConnectionConfig;
  token?: string;
}

export interface WebviewMessageAddServer {
  type: 'addServer';
  config: { name: string; scheme: "http" | "https"; host: string; port: number };
  token?: string;
}

export interface WebviewMessageRemoveServer {
  type: 'removeServer';
  name: string;
}

export interface WebviewMessageEditServer {
  type: 'editServer';
  name: string;
  config?: { scheme?: "http" | "https"; host?: string; port?: number };
  token?: string;
}

export interface WebviewMessageValidationError {
  type: 'validationError';
  field: string;
  message: string;
}

export interface WebviewMessageLoadModelDefault {
  type: 'loadModelDefault';
  modelKey: string;
  instanceId?: string;
}

export interface WebviewMessageLoadModelSettings {
  type: 'loadModelSettings';
  payload: {
    modelKey: string;
    instanceId?: string;
    config: Record<string, unknown>;
  };
}

export interface WebviewMessageUnloadModel {
  type: 'unloadModel';
  instanceId: string;
}

export interface WebviewMessageUnloadAllModels {
  type: 'unloadAllModels';
}

export interface WebviewMessageReloadModelSettings {
  type: 'reloadModelSettings';
  payload: {
    modelKey: string;
    instanceId?: string;
    config: Record<string, unknown>;
  };
}

export interface WebviewMessageRefreshServer {
  type: 'refreshServer';
  serverName: string;
}

export interface WebviewMessageRefreshAll {
  type: 'refreshAll';
}

// New: sent by webview when user toggles a model's Copilot checkbox
export interface WebviewMessageSetCopilotEnabled {
  type: 'setCopilotEnabled';
  modelKey: string;
  enabled: boolean;
}

// Union of all inbound message types from webview
export type WebviewInboundMessage =
  | WebviewMessageInit
  | WebviewMessageFetchConnections
  | WebviewMessageFetchModels
  | WebviewMessageActiveServerChanged
  | WebviewMessageSwitchConnection
  | WebviewMessageTestConnection
  | WebviewMessageAddServer
  | WebviewMessageRemoveServer
  | WebviewMessageEditServer
  | WebviewMessageValidationError
  | WebviewMessageLoadModelDefault
  | WebviewMessageLoadModelSettings
  | WebviewMessageUnloadModel
  | WebviewMessageUnloadAllModels
  | WebviewMessageReloadModelSettings
  | WebviewMessageRefreshServer
  | WebviewMessageRefreshAll
  | WebviewMessageSetCopilotEnabled;

// ── Extension → Webview (outbound messages) ───────────────────

export interface WebviewOutboundConnectionsUpdated {
  type: 'connectionsUpdated';
  connections: ConnectionConfig[];
  activeName: string;
  lastConnectedMap: Record<string, boolean>;
}

export interface WebviewOutboundConnectionTested {
  type: 'connectionTested';
  success: boolean;
  error?: string;
}

// Extended: includes copilotEnabled map so the webview can render checkboxes
export interface WebviewOutboundModelsUpdated {
  type: 'modelsUpdated';
  serverName: string;
  models: LmStudioModel[];
  copilotEnabled: Record<string, boolean>;
  modelTemperatures: Record<string, number>;
}

export interface WebviewOutboundOperationProgress {
  type: 'operationProgress';
  message: string;
}

export interface WebviewOutboundOperationComplete {
  type: 'operationComplete';
  message: string;
}

export interface WebviewOutboundOperationFailed {
  type: 'operationFailed';
  error: string;
}

export interface WebviewOutboundTokenRequiredForServer {
  type: 'tokenRequiredForServer';
  serverName: string;
}

// Union of all outbound message types to webview
export type WebviewOutboundMessage =
  | WebviewOutboundConnectionsUpdated
  | WebviewOutboundConnectionTested
  | WebviewOutboundModelsUpdated
  | WebviewOutboundOperationProgress
  | WebviewOutboundOperationComplete
  | WebviewOutboundOperationFailed
  | WebviewOutboundTokenRequiredForServer;
