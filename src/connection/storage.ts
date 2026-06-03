import * as vscode from "vscode";
import { ConnectionConfig } from "../api/types";

const CONNECTIONS_KEY = "lmstudioManager.connections";
const ACTIVE_CONNECTION_KEY = "lmstudioManager.activeConnection";

export class ConnectionStorage {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getConnections(): ConnectionConfig[] {
    const connections = this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
    return connections.map((c) => ({
      name: c.name,
      scheme: c.scheme ?? "http",
      host: c.host,
      port: c.port,
    }));
  }

  async saveConnections(connections: ConnectionConfig[]): Promise<void> {
    await this.context.globalState.update(CONNECTIONS_KEY, connections);
  }

  async migrateFromWorkspaceConfig(): Promise<void> {
    const alreadyMigrated = this.context.globalState.get<boolean>("lmstudioManager.migrated", false);
    if (alreadyMigrated) { return; }
    const wsConfig = vscode.workspace.getConfiguration();
    const legacy = wsConfig.get<ConnectionConfig[]>(CONNECTIONS_KEY);
    if (legacy && legacy.length > 0) {
      await this.context.globalState.update(CONNECTIONS_KEY, legacy);
      await wsConfig.update(CONNECTIONS_KEY, undefined, vscode.ConfigurationTarget.Global);
    }
    await this.context.globalState.update("lmstudioManager.migrated", true);
  }

  async getToken(name: string): Promise<string | undefined> {
    return this.context.secrets.get(`token-${name}`);
  }

  async saveToken(name: string, token: string | undefined): Promise<void> {
    if (token) {
      await this.context.secrets.store(`token-${name}`, token);
    } else {
      await this.context.secrets.delete(`token-${name}`);
    }
  }

  getActiveConnection(): string | undefined {
    return this.context.globalState.get<string>(ACTIVE_CONNECTION_KEY);
  }

  async setActiveConnection(name: string | undefined): Promise<void> {
    await this.context.globalState.update(ACTIVE_CONNECTION_KEY, name);
  }

  getDefaultConnection(): ConnectionConfig {
    return { name: "Local", scheme: "http", host: "localhost", port: 1234 };
  }
}
