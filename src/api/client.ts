import {
  ApiModelsResponse,
  LoadModelRequest,
  LoadModelResponse,
  UnloadModelRequest,
  UnloadModelResponse,
  ConnectionConfig,
} from "./types";

export class LmStudioApiClient {
  constructor(
    private readonly connection: ConnectionConfig,
    private readonly getToken?: (name: string) => Promise<string | undefined>,
  ) {}

  private get baseUrl(): string {
    return `${this.connection.scheme}://${this.connection.host}:${this.connection.port}`;
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    timeoutMs: number = 10000,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.getToken) {
      const token = await this.getToken(this.connection.name);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body && method === "POST") {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);
      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMessage: string;
        try {
          const errorBody = (await response.json()) as { error?: string };
          errorMessage = errorBody.error || `HTTP ${response.status}`;
        } catch {
          errorMessage = `HTTP ${response.status}`;
        }

        if (response.status === 401) {
          throw new Error("Authentication failed — check the API token for " + this.connection.name);
        }

        throw new Error(`${errorMessage} (${response.status})`);
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request to ${path} timed out after ${timeoutMs / 1000}s`);
      }
      throw error;
    }
  }

  async getModels(): Promise<ApiModelsResponse> {
    return this.request("/api/v1/models", "GET");
  }

  async loadModel(request: LoadModelRequest): Promise<LoadModelResponse> {
    return this.request("/api/v1/models/load", "POST", request, 300000);
  }

  async unloadModel(request: UnloadModelRequest): Promise<UnloadModelResponse> {
    return this.request("/api/v1/models/unload", "POST", request);
  }

  async ping(): Promise<boolean> {
    try {
      await this.getModels();
      return true;
    } catch {
      return false;
    }
  }
}
