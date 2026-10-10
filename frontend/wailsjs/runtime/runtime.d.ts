// Cynan

export function EventsEmit(eventName: string, ...data: any[]): void;
export function EventsOn(eventName: string, callback: (...data: any) => void): () => void;
export function EventsOnMultiple(eventName: string, callback: (...data: any) => void, maxCallbacks: number): () => void;
export function EventsOnce(eventName: string, callback: (...data: any) => void): () => void;
export function EventsOff(...eventNames: string[]): void;
export function EventsOffAll(): void;
export function WindowMinimise(): void;
export function WindowMaximise(): void;
export function WindowUnmaximise(): void;
export function WindowFullscreen(): void;
export function WindowUnfullscreen(): void;
export function WindowClose(): void;
export function LogPrint(message: string): void;
export function LogTrace(message: string): void;
export function LogDebug(message: string): void;
export function LogInfo(message: string): void;
export function LogWarning(message: string): void;
export function LogError(message: string): void;
export function LogFatal(message: string): void;
