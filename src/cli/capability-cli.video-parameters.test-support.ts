import { expect, it, type Mock } from "vitest";
import { runCapability } from "./capability-cli.test-harness.js";

type OutputFixture = { dir: string; outputBase: string; outputPath: string };

type VideoParametersHarness = {
  mocks: {
    generateVideo: { mockResolvedValue(value: unknown): unknown };
    runtime: { log: Mock<() => void> };
  };
  outputFixture: (extension: string, original: string) => Promise<OutputFixture>;
  expectOutputFile: (fixture: OutputFixture, contents: string) => Promise<void>;
  firstVideoGenerationCall: () => Record<string, unknown> | undefined;
  firstJsonOutput: () => Record<string, unknown> | undefined;
};

// Register in the caller's suite so its mocks and temp-directory hooks keep ownership.
export function registerVideoParametersTests({
  mocks,
  outputFixture,
  expectOutputFile,
  firstVideoGenerationCall,
  firstJsonOutput,
}: VideoParametersHarness): void {
  it.each([
    { format: "JSON", ignored: true },
    { format: "JSON", ignored: false },
    { format: "text", ignored: true },
    { format: "text", ignored: false },
  ])(
    "passes video generation parameters through to runtime ($format, ignored: $ignored)",
    async ({ format, ignored }) => {
      const ignoredOverrides = ignored
        ? [
            { key: "audio", value: true },
            { key: "watermark", value: true },
          ]
        : [];
      const fixture = await outputFixture(".mp4", "previous-video");
      mocks.generateVideo.mockResolvedValue({
        provider: "minimax",
        model: "MiniMax-Hailuo-2.3",
        attempts: [],
        ignoredOverrides,
        videos: [
          {
            buffer: Buffer.from("video-bytes"),
            mimeType: "video/mp4",
            fileName: "provider-name.mp4",
          },
        ],
      });

      await runCapability(
        "video",
        "generate",
        "--prompt",
        "friendly lobster",
        "--model",
        "minimax/MiniMax-Hailuo-2.3",
        "--size",
        "1280x768",
        "--aspect-ratio",
        "16:9",
        "--resolution",
        "768p",
        "--duration",
        "2.5",
        "--audio",
        "--watermark",
        "--timeout-ms",
        "300000",
        "--output",
        fixture.outputBase,
        ...(format === "JSON" ? ["--json"] : []),
      );

      const videoCall = firstVideoGenerationCall();
      expect(videoCall?.prompt).toBe("friendly lobster");
      expect(videoCall?.modelOverride).toBe("minimax/MiniMax-Hailuo-2.3");
      expect(videoCall?.size).toBe("1280x768");
      expect(videoCall?.aspectRatio).toBe("16:9");
      expect(videoCall?.resolution).toBe("768P");
      expect(videoCall?.durationSeconds).toBe(2.5);
      expect(videoCall?.audio).toBe(true);
      expect(videoCall?.watermark).toBe(true);
      expect(videoCall?.timeoutMs).toBe(300000);
      await expectOutputFile(fixture, "video-bytes");
      if (format === "JSON") {
        expect(firstJsonOutput()?.ignoredOverrides).toBe(ignoredOverrides);
        expect(firstJsonOutput()?.outputs).toEqual([
          { path: fixture.outputPath, mimeType: "video/mp4", size: 11 },
        ]);
      } else {
        expect(mocks.runtime.log).toHaveBeenCalledWith(
          [
            "video.generate via local",
            "provider: minimax",
            "model: MiniMax-Hailuo-2.3",
            ...(ignored
              ? [
                  'ignoredOverrides: [{"key":"audio","value":true},{"key":"watermark","value":true}]',
                ]
              : []),
            "outputs: 1",
            fixture.outputPath,
          ].join("\n"),
        );
      }
    },
  );
}
