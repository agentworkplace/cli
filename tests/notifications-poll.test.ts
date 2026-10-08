import { expect, test, vi } from "vitest";
import { AgentWorkplaceError } from "@agent-workplace/sdk";
import { pollNotifications } from "../src/commands/notifications.js";
const account = "11111111-1111-4111-8111-111111111111";
const status = (sequence: number, unreadCount = 1) => ({
  position: `np1.${account}.${sequence}`,
  unreadCount,
  oldestUnreadAt: unreadCount ? "2026-10-07T00:00:00.000Z" : null,
});
test("wait without a marker emits existing unread activity immediately", async () => {
  const emit = vi.fn(),
    wait = vi.fn();
  await pollNotifications({
    watch: false,
    read: async () => status(1),
    emit,
    wait,
  });
  expect(emit).toHaveBeenCalledExactlyOnceWith(status(1));
  expect(wait).not.toHaveBeenCalled();
});
test("wait requires both newer activity and unread items; transient errors do not advance marker", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(status(1))
    .mockResolvedValueOnce(status(2, 0))
    .mockRejectedValueOnce(
      new AgentWorkplaceError("Throttled", {
        status: 429,
        retryAfterSeconds: 40,
      }),
    )
    .mockResolvedValueOnce(status(3));
  const emit = vi.fn(),
    wait = vi.fn();
  await pollNotifications({
    watch: false,
    after: status(1).position,
    read,
    emit,
    wait,
  });
  expect(wait.mock.calls.map(([delay]) => delay)).toEqual([
    15000, 15000, 40000,
  ]);
  expect(emit).toHaveBeenCalledExactlyOnceWith(status(3));
});
test("watch spaces outputs by at least 60 seconds and never reminds at the same position", async () => {
  const stop = new Error("stop fixture");
  const read = vi
    .fn()
    .mockResolvedValueOnce(status(1))
    .mockResolvedValueOnce(status(1))
    .mockResolvedValueOnce(status(2))
    .mockRejectedValue(stop);
  const emit = vi.fn(),
    wait = vi.fn();
  await expect(
    pollNotifications({ watch: true, read, emit, wait }),
  ).rejects.toBe(stop);
  expect(wait.mock.calls.map(([delay]) => delay)).toEqual([
    60000, 15000, 60000,
  ]);
  expect(emit.mock.calls.map(([value]) => value.position)).toEqual([
    status(1).position,
    status(2).position,
  ]);
});
test.each([401, 403])(
  "lost authority %s terminates without backoff",
  async (code) => {
    const error = new AgentWorkplaceError("Denied", { status: code });
    const wait = vi.fn();
    await expect(
      pollNotifications({
        watch: false,
        read: async () => {
          throw error;
        },
        emit: vi.fn(),
        wait,
      }),
    ).rejects.toBe(error);
    expect(wait).not.toHaveBeenCalled();
  },
);
