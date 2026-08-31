// Catalog of common infra services for the Stack canvas. Client-safe constant.

import type { EnvVar, PortMapping, VolumeMapping } from "./types";

export type ServiceDef = {
  key: string;
  name: string;
  image: string;
  description: string;
  ports: PortMapping[];
  env: EnvVar[];
  volumes: VolumeMapping[];
};

export const SERVICE_CATALOG: ServiceDef[] = [
  {
    key: "postgres",
    name: "PostgreSQL",
    image: "postgres:17",
    description: "Relational database",
    ports: [{ host: 5432, container: 5432 }],
    env: [
      { key: "POSTGRES_USER", value: "postgres" },
      { key: "POSTGRES_PASSWORD", value: "postgres" },
      { key: "POSTGRES_DB", value: "app" },
    ],
    volumes: [{ host: "pgdata", container: "/var/lib/postgresql/data" }],
  },
  {
    key: "mysql",
    name: "MySQL",
    image: "mysql:8",
    description: "Relational database",
    ports: [{ host: 3306, container: 3306 }],
    env: [
      { key: "MYSQL_ROOT_PASSWORD", value: "root" },
      { key: "MYSQL_DATABASE", value: "app" },
    ],
    volumes: [{ host: "mysqldata", container: "/var/lib/mysql" }],
  },
  {
    key: "redis",
    name: "Redis",
    image: "redis:7",
    description: "In-memory cache / queue",
    ports: [{ host: 6379, container: 6379 }],
    env: [],
    volumes: [],
  },
  {
    key: "mongo",
    name: "MongoDB",
    image: "mongo:8",
    description: "Document database",
    ports: [{ host: 27017, container: 27017 }],
    env: [],
    volumes: [{ host: "mongodata", container: "/data/db" }],
  },
  {
    key: "ollama",
    name: "Ollama",
    image: "ollama/ollama",
    description: "Local LLM server",
    ports: [{ host: 11434, container: 11434 }],
    env: [],
    volumes: [{ host: "ollamadata", container: "/root/.ollama" }],
  },
  {
    key: "minio",
    name: "MinIO",
    image: "minio/minio",
    description: "S3-compatible object storage",
    ports: [
      { host: 9000, container: 9000 },
      { host: 9001, container: 9001 },
    ],
    env: [
      { key: "MINIO_ROOT_USER", value: "minio" },
      { key: "MINIO_ROOT_PASSWORD", value: "minio12345" },
    ],
    volumes: [{ host: "miniodata", container: "/data" }],
  },
  {
    key: "mailpit",
    name: "Mailpit",
    image: "axllent/mailpit",
    description: "SMTP catcher for dev email",
    ports: [
      { host: 8025, container: 8025 },
      { host: 1025, container: 1025 },
    ],
    env: [],
    volumes: [],
  },
];

// minio needs an explicit server command
export const SERVICE_COMMANDS: Record<string, string> = {
  minio: "server /data --console-address :9001",
};
