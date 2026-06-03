import * as vscode from "vscode";
import { ConnectionConfig } from "../api/types";
import { LmStudioApiClient } from "../api/client";
import { ConnectionStorage } from "./storage";

export class ConnectionManager {
  private storage: ConnectionStorage;
  private activeClient: LmStudioApiClient | undefined;
  private activeName: string | undefined;
  private lastConnected = false;
  private getToken: (name: string) => Promise<string | undefined>;

  constructor(
    _context: vscode.ExtensionContext,
    storage: ConnectionStorage,
    getToken: (name: string) => Promise<string | undefined>,
  ) {
    this.storage = storage;
    this.getToken = getToken;
    this.activeName = storage.getActiveConnection();
    if (this.activeName) {
      const config = this.findConnection(this.activeName);
      if (config) {
        this.activeClient = new LmStudioApiClient(config, this.getToken);
      } else {
        this.activeName = undefined;
      }
    }
    if (!this.activeClient) {
      // Prefer the first stored connection (may have been added by vscode-lmstudio-manager).
      // Fall back to the built-in localhost:1234 default only if no connections are stored.
      const stored = storage.getConnections();
      const firstConn = stored[0] ?? storage.getDefaultConnection();
      this.activeName = firstConn.name;
      this.activeClient = new LmStudioApiClient(firstConn, this.getToken);
    }
  }

  private findConnection(name: string): ConnectionConfig | undefined {
    return this.storage.getConnections().find((c) => c.name === name);
  }

  getActiveClient(): LmStudioApiClient | undefined {
    return this.activeClient;
  }

  getActiveName(): string | undefined {
    return this.activeName;
  }

  getActiveConfig(): ConnectionConfig | undefined {
    if (!this.activeName) { return undefined; }
    return this.findConnection(this.activeName);
  }

  getLastConnected(): boolean {
    return this.lastConnected;
  }

  setLastConnected(connected: boolean): void {
    this.lastConnected = connected;
  }

  async switchConnection(name: string): Promise<boolean> {
    const config = this.findConnection(name);
    if (!config) { return false; }
    this.activeName = name;
    this.activeClient = new LmStudioApiClient(config, this.getToken);
    await this.storage.setActiveConnection(name);
    return true;
  }

  async addConnection(connection: ConnectionConfig): Promise<boolean> {
    const connections = this.storage.getConnections();
    if (connections.some((c) => c.name === connection.name)) { return false; }
    connections.push(connection);
    await this.storage.saveConnections(connections);
    return true;
  }

  async removeConnection(name: string): Promise<boolean> {
    const connections = this.storage.getConnections();
    if (connections.length <= 1) { return false; }
    const remaining = connections.filter((c) => c.name !== name);
    if (remaining.length === 0) { return false; }
    await this.storage.saveConnections(remaining);
    if (name === this.activeName) {
      const newActive = remaining[0]?.name;
      if (newActive) { await this.switchConnection(newActive); }
    }
    return true;
  }
}
