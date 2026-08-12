import { native } from "./bridge";

export enum BaseDirectory {
	Audio = 1, Cache = 2, Config = 3, Data = 4, LocalData = 6, Desktop = 7,
	Document = 8, Download = 9, Home = 11, Picture = 15, Public = 18,
	Resource = 20, Temp = 21, Template = 22, Video = 24, AppConfig = 25,
	AppData = 26, AppLocalData = 27, AppCache = 28, AppLog = 29,
}
export interface FsOptions { baseDir?: BaseDirectory; }
export interface RemoveOptions extends FsOptions { recursive?: boolean; }
export interface MkdirOptions extends FsOptions { recursive?: boolean; }
export interface DirEntry { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean; }
export interface FileInfo { size: number; isFile: boolean; isDirectory: boolean; isSymlink: boolean; mtime: Date | null; atime: Date | null; birthtime: Date | null; }

const options = (path: string, value?: FsOptions) => ({ path, baseDir: value?.baseDir });
export const exists = (path: string, value?: FsOptions) => native<boolean>("fs.exists", options(path, value));
export const readFile = (path: string, value?: FsOptions) => native<number[]>("fs.readFile", options(path, value)).then((bytes) => new Uint8Array(bytes));
export const readTextFile = (path: string, value?: FsOptions) => native<string>("fs.readTextFile", options(path, value));
export const writeFile = (path: string, data: Uint8Array, value?: FsOptions) => native<void>("fs.writeFile", { ...options(path, value), data: Array.from(data) });
export const writeTextFile = (path: string, contents: string, value?: FsOptions) => native<void>("fs.writeTextFile", { ...options(path, value), contents });
export const remove = (path: string, value?: RemoveOptions) => native<void>("fs.remove", { ...options(path, value), recursive: value?.recursive });
export const mkdir = (path: string, value?: MkdirOptions) => native<void>("fs.mkdir", { ...options(path, value), recursive: value?.recursive });
export const readDir = (path: string, value?: FsOptions) => native<DirEntry[]>("fs.readDir", options(path, value));
export const stat = (path: string, value?: FsOptions) => native<FileInfo>("fs.stat", options(path, value));
export const lstat = stat;
export const copyFile = (_source: string, _destination: string, _options?: FsOptions) => Promise.reject(new Error("copyFile is not implemented"));
export const rename = (_oldPath: string, _newPath: string, _options?: FsOptions) => Promise.reject(new Error("rename is not implemented"));
export const truncate = (_path: string, _length?: number, _options?: FsOptions) => Promise.reject(new Error("truncate is not implemented"));
