// 门槛队列：同一时间只跑一个门槛；票的门槛优先，main 兜底完整测试只在没有票等门槛时才开跑。
// Gate queue: one gate at a time; tickets' gates come first, and the main fallback full run starts only when no ticket is waiting for the gate.
// 同档内先来先得；已经开跑的不中断（沙箱 exec 没有中断接口）。
// First come first served within a tier; a gate already running is not interrupted (sandbox exec has no interrupt).

export type GatePriority = "ticket" | "fallback";

type Waiter = { start: () => void; yielded: boolean };

export type GateQueue = { run<T>(fn: () => Promise<T>, prio: GatePriority): Promise<T> };

/**
 * 建一个门槛队列。onYield：有兜底在等、却先放行了票时调用（同一次等待只调一次），参数是放行前在等的票数。
 * Create a gate queue. onYield: called when a fallback is waiting but a ticket is released first (once per wait), with the number of tickets waiting before the release.
 */
export function createGateQueue(opts: { onYield?: (waitingTickets: number) => void } = {}): GateQueue {
  let running = false;
  const tickets: Waiter[] = [];
  const fallbacks: Waiter[] = [];

  const pump = () => {
    if (running) return;
    const waitingTickets = tickets.length;
    const next = tickets.shift() ?? fallbacks.shift();
    if (!next) return;
    if (waitingTickets > 0 && fallbacks.length > 0 && !fallbacks[0].yielded) {
      // 放行的是票、兜底还在等：提示一次让位。 / A ticket was released while the fallback waits: report the yield once.
      fallbacks[0].yielded = true;
      opts.onYield?.(waitingTickets);
    }
    running = true;
    next.start();
  };

  return {
    run<T>(fn: () => Promise<T>, prio: GatePriority): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const waiter: Waiter = {
          yielded: false,
          start: () => {
            void (async () => {
              try {
                resolve(await fn());
              } catch (e) {
                reject(e);
              } finally {
                // 成功失败都释放，失败的门槛不能卡住队列。 / Release on success and failure alike, so a failed gate never blocks the queue.
                running = false;
                pump();
              }
            })();
          },
        };
        (prio === "ticket" ? tickets : fallbacks).push(waiter);
        pump();
      });
    },
  };
}
