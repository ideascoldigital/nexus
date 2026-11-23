// Connectors (spec 35), the browser's side. The catalog itself is lib/connectors.
import type { ConnectorStatus } from "@/services/connector-store";

export type { ConnectorStatus };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: unknown }).error;
    throw new Error(typeof err === "string" ? err : `Request failed (${res.status})`);
  }
  return body as T;
}

export const listConnectors = () => call<ConnectorStatus[]>("/api/connectors");

export const saveConnector = (id: string, values: Record<string, string | boolean>, botIds?: string[] | null) =>
  call<{ ok: true }>(`/api/connectors/${id}`, { method: "PUT", body: JSON.stringify({ values, botIds }) });

export const setConnectorBots = (id: string, botIds: string[] | null) =>
  call<{ ok: true }>(`/api/connectors/${id}`, { method: "PATCH", body: JSON.stringify({ botIds }) });

export const disconnectConnector = (id: string) => call<{ ok: true }>(`/api/connectors/${id}`, { method: "DELETE" });
