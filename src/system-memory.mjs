// How much room is there actually left on this machine?
//
// This exists for one specific failure: a qualification run that spent six
// minutes loading 11 GiB on a machine that was already 5% free with a full swap
// file, then recorded the timeout as a model failure. The distinction between
// "the model cannot do this" and "the machine cannot do this right now" is the
// whole point, and it is not visible from a `pgrep`.
//
// The classification below is advisory. Normal local-model use never refuses on
// it; only the measurement harness treats it as a gate.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GIB = 1024 ** 3;

// Deliberately coarse. A machine in the state that produced the bad run had
// swap pinned near its ceiling and single-digit free memory; a healthy one has
// swap essentially untouched. Anything between is a judgement call, and saying
// so is better than pretending to a precise threshold.
export const FREE_CRITICAL_PERCENT = 10;
export const FREE_WARNING_PERCENT = 20;
export const SWAP_WARNING_BYTES = 2 * GIB;

function parseVmStat(text) {
  const pages = {};
  for (const line of text.split("\n")) {
    const match = /^Pages ([a-z ]+):\s+(\d+)\.?/.exec(line.trim());
    if (match) pages[match[1].trim()] = Number(match[2]);
  }
  const pageSizeMatch = /page size of (\d+)/.exec(text);
  return { pages, pageSize: pageSizeMatch ? Number(pageSizeMatch[1]) : 16_384 };
}

function parseSwap(text) {
  const match = /total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M/i.exec(text || "");
  if (!match) return {};
  return {
    swapTotalBytes: Number(match[1]) * 1024 * 1024,
    swapUsedBytes: Number(match[2]) * 1024 * 1024,
  };
}

function parseMeminfo(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+) kB/.exec(line);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  return values;
}

export function classifyMemory({ totalBytes, availableBytes, swapUsedBytes }) {
  const availablePercent =
    totalBytes > 0 ? Math.round((availableBytes / totalBytes) * 100) : undefined;
  const reasons = [];
  let pressure = "normal";
  if (availablePercent !== undefined && availablePercent < FREE_CRITICAL_PERCENT) {
    pressure = "critical";
    reasons.push(`only ${availablePercent}% of memory is available`);
  }
  if ((swapUsedBytes || 0) > SWAP_WARNING_BYTES) {
    if (pressure !== "critical") pressure = "warning";
    reasons.push(`swap already holds ${(swapUsedBytes / GIB).toFixed(1)} GiB`);
  } else if (
    pressure === "normal" &&
    availablePercent !== undefined &&
    availablePercent < FREE_WARNING_PERCENT
  ) {
    pressure = "warning";
    reasons.push(`only ${availablePercent}% of memory is available`);
  }
  return { availablePercent, pressure, reasons };
}

export function readSystemMemory({
  platform = process.platform,
  spawn = spawnSync,
  readFile = readFileSync,
} = {}) {
  try {
    if (platform === "darwin") {
      const vmStat = spawn("vm_stat", [], { encoding: "utf8" }).stdout || "";
      const { pages, pageSize } = parseVmStat(vmStat);
      const totalBytes =
        Number(spawn("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).stdout || 0) ||
        undefined;
      const swap = parseSwap(
        spawn("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }).stdout,
      );
      const availablePages =
        (pages.free || 0) +
        (pages.inactive || 0) +
        (pages.speculative || 0) +
        (pages.purgeable || 0);
      const availableBytes = availablePages * pageSize;
      const compressionBytes = (pages["occupied by compressor"] || 0) * pageSize;
      const wiredBytes = (pages["wired down"] || 0) * pageSize;
      return {
        platform,
        totalBytes,
        availableBytes,
        freeBytes: (pages.free || 0) * pageSize,
        wiredBytes,
        compressionBytes,
        ...swap,
        ...classifyMemory({ totalBytes, availableBytes, swapUsedBytes: swap.swapUsedBytes }),
      };
    }
    if (platform === "linux") {
      const values = parseMeminfo(readFile("/proc/meminfo", "utf8"));
      const totalBytes = values.MemTotal;
      const availableBytes = values.MemAvailable;
      const swapUsedBytes = Math.max(0, (values.SwapTotal || 0) - (values.SwapFree || 0));
      return {
        platform,
        totalBytes,
        availableBytes,
        swapTotalBytes: values.SwapTotal,
        swapUsedBytes,
        ...classifyMemory({ totalBytes, availableBytes, swapUsedBytes }),
      };
    }
  } catch {
    // A machine that cannot answer is not classified, and nothing gates on the
    // absence of an answer.
  }
  return { platform, pressure: "unknown", reasons: [] };
}
