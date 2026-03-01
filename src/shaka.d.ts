// Minimal Shaka Player type declarations for CDN-loaded version
declare namespace shaka {
  namespace polyfill { function installAll(): void; }
  class Player {
    constructor(video: HTMLVideoElement);
    static isBrowserSupported(): boolean;
    configure(config: object): void;
    load(url: string): Promise<void>;
    destroy(): Promise<void>;
    getNetworkingEngine(): {
      registerRequestFilter(fn: (type: unknown, request: { headers: Record<string, string>; uris: string[] }) => void): void;
      clearAllRequestFilters(): void;
    };
    addEventListener(event: string, handler: (e: { detail?: unknown }) => void): void;
  }
  namespace net {
    namespace NetworkingEngine {
      enum RequestType { MANIFEST, SEGMENT, LICENSE, APP, TIMING }
    }
  }
}
interface Window { shaka: typeof shaka; }
