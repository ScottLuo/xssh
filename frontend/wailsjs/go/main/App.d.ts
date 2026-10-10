// Cynan
export function CloseTab(arg1:string):Promise<void>;
export function DeleteHost(arg1:string):Promise<void>;
export function GetHosts():Promise<Array<main.Host>>;
export function GetSettings():Promise<Record<string,string>>;
export function OpenTab(arg1:string,arg2:number,arg3:number):Promise<string>;
export function Resize(arg1:string,arg2:number,arg3:number):Promise<void>;
export function SaveHost(arg1:any):Promise<void>;
export function SetSetting(arg1:string,arg2:string):Promise<void>;
export function SetupDB(arg1:string):Promise<void>;
export function UnlockDB(arg1:string):Promise<void>;
export function Write(arg1:string,arg2:string):Promise<void>;

declare namespace main {
  interface Host {
    id: string;
    name: string;
    host: string;
    port: number;
    user: string;
    auth_type: string;
    auth_secret: string;
    shell: string;
    init_cmds: string[];
    color: string;
    created_at: string;
    updated_at: string;
  }
}
