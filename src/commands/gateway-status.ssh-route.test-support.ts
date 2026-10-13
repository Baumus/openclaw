import { expect, it, type Mock } from "vitest";
import type { probeGateway } from "../gateway/probe.js";
import { withEnvAsync } from "../test-utils/env.js";

type RemoteGatewayConfig = {
  gateway: { mode: string; remote: { url: string; token: string }; auth: { token: string } };
};
type CapturedRuntime = {
  log: (message: string) => number;
  error: (message: string) => number;
  exit: (code: number) => never;
};
type SshRouteHarness = {
  createRuntimeCapture: () => { runtime: CapturedRuntime; runtimeLogs: string[] };
  readBestEffortConfig: { mockResolvedValueOnce(value: RemoteGatewayConfig): unknown };
  resolveSshConfig: {
    mockResolvedValueOnce(value: {
      user: string;
      host: string;
      port: number;
      identityFiles: string[];
    }): unknown;
  };
  startSshPortForward: { mockClear(): unknown };
  sshStop: Mock<() => Promise<void>>;
  makeRemoteGatewayConfig: (
    url: string,
    token?: string,
    localToken?: string,
  ) => RemoteGatewayConfig;
  runGatewayStatus: (
    runtime: CapturedRuntime,
    opts: { timeout: string; json: boolean; ssh?: string },
  ) => Promise<void>;
  requireSshForwardCall: () => Record<string, unknown>;
  readProbeCalls: () => Parameters<typeof probeGateway>[0][];
};

// Register in the existing suite; it remains the sole owner of mock reset and capture.
export function registerSshRouteTests({
  createRuntimeCapture,
  readBestEffortConfig,
  resolveSshConfig,
  startSshPortForward,
  sshStop,
  makeRemoteGatewayConfig,
  runGatewayStatus,
  requireSshForwardCall,
  readProbeCalls,
}: SshRouteHarness): void {
  it.each([
    { ssh: "alias:22", port: 22, explicitPort: true },
    { ssh: "alias", port: 2222, explicitPort: false },
    { ssh: "alias:2022", port: 2022, explicitPort: true },
  ])(
    "preserves $ssh through the probe command and prepared route",
    async ({ ssh, port, explicitPort }) => {
      const { runtime, runtimeLogs } = createRuntimeCapture();
      resolveSshConfig.mockResolvedValueOnce({
        user: "me",
        host: "resolved.example",
        port,
        identityFiles: [],
      });
      await runGatewayStatus(runtime, { timeout: "1000", json: true, ssh });
      expect(resolveSshConfig).toHaveBeenCalledWith(
        expect.objectContaining({ host: "alias" }),
        expect.objectContaining({ explicitPort }),
      );
      expect(requireSshForwardCall().target).toBe(`me@resolved.example:${port}`);
      const probe = readProbeCalls().find((call) => call.url.startsWith("ws://127.0.0.1:"));
      expect(probe?.sshTunnel).toMatchObject({ target: ssh, remotePort: 18789 });
      expect(sshStop).toHaveBeenCalledTimes(1);
      expect(JSON.parse(runtimeLogs.join("\n")).targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "sshTunnel",
            tunnel: expect.objectContaining({ target: `me@resolved.example:${port}` }),
          }),
        ]),
      );
    },
  );

  it("infers SSH target from gateway.remote.url and ssh config", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(
        makeRemoteGatewayConfig("ws://peters-mac-studio-1.sheep-coho.ts.net:18789"),
      );
      resolveSshConfig.mockResolvedValueOnce({
        user: "steipete",
        host: "peters-mac-studio-1.sheep-coho.ts.net",
        port: 2222,
        identityFiles: ["/tmp/id_ed25519"],
      });

      startSshPortForward.mockClear();
      await runGatewayStatus(runtime, { timeout: "1000", json: true });

      expect(startSshPortForward).toHaveBeenCalledTimes(1);
      const call = requireSshForwardCall();
      expect(call.target).toBe("steipete@peters-mac-studio-1.sheep-coho.ts.net:2222");
      expect(call.identity).toBe("/tmp/id_ed25519");
    });
  });
}
