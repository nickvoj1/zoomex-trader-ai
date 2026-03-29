import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireProcessLock(name: string, lockDir = path.join("research", "locks")) {
  await mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${name}.lock`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      const release = async () => {
        await handle.close().catch(() => null);
        await rm(lockPath, { force: true }).catch(() => null);
      };
      await writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }, null, 2));

      const cleanup = () => {
        void release();
      };
      process.on("exit", cleanup);
      process.on("SIGINT", () => {
        cleanup();
        process.exit(130);
      });
      process.on("SIGTERM", () => {
        cleanup();
        process.exit(143);
      });

      return {
        lockPath,
        release,
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const existingText = await readFile(lockPath, "utf8").catch(() => null);
      if (!existingText) {
        await rm(lockPath, { force: true }).catch(() => null);
        continue;
      }

      try {
        const existing = JSON.parse(existingText) as { pid?: number };
        if (typeof existing.pid === "number" && isProcessAlive(existing.pid)) {
          throw new Error(`Process lock ${name} is already held by pid ${existing.pid}`);
        }
      } catch (parseError) {
        if (parseError instanceof Error && parseError.message.startsWith("Process lock")) {
          throw parseError;
        }
      }

      await rm(lockPath, { force: true }).catch(() => null);
    }
  }

  throw new Error(`Failed to acquire process lock ${name}`);
}
