export interface FileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  mtime: Date;
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface StorageAdapter {
  read(key: string): Promise<Buffer>;
  readText(key: string): Promise<string>;
  write(key: string, data: Buffer | string): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<FileStat>;
  list(prefix: string): Promise<string[]>;
  listDetailed(prefix: string): Promise<DirEntry[]>;
  mkdir(key: string): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
}
