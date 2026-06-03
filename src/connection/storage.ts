import * as vscode from "vscode";
import { ConnectionConfig } from "../api/types";

const CONNECTIONS_KEY = "lmstudioManager.connections";
const ACTIVE_CONNECTION_KEY = "lmstudioManager.activeConnection";

export class ConnectionStorage {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getConnections(): ConnectionConfig[] {
    const config = vscode.workspace.getConfiguration();
    const connections = config.get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
    return connections.map((c) => ({
      name: c.name,
      scheme: c.scheme ?? "http",
      host: c.host,
      port: c.port,
    }));
  }

  async saveConnections(connections: ConnectionConfig[]): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    await config.update(CONNECTIONS_KEY, connections, vscode.ConfigurationTarget.Global);
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
