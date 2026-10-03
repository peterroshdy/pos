export type CashDrawerDispatch = {
  dispatched: boolean;
  hardwareError: string | null;
};

type DispatchCashDrawerOptions = {
  commandUrl?: string | undefined;
  commandToken?: string | undefined;
  branchId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export async function dispatchCashDrawer({
  commandUrl,
  commandToken,
  branchId,
  timeoutMs = 3_000,
  fetchImpl = fetch,
}: DispatchCashDrawerOptions): Promise<CashDrawerDispatch> {
  if (!commandUrl?.trim()) {
    return {
      dispatched: false,
      hardwareError: "Cash drawer hardware bridge is not configured",
    };
  }

  try {
    const response = await fetchImpl(commandUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(commandToken
          ? { authorization: `Bearer ${commandToken}` }
          : {}),
      },
      body: JSON.stringify({ command: "open-drawer", branchId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new Error(`Hardware bridge returned ${response.status}`);
    return { dispatched: true, hardwareError: null };
  } catch (error) {
    return {
      dispatched: false,
      hardwareError:
        error instanceof Error
          ? error.message.slice(0, 200)
          : "Hardware bridge failed",
    };
  }
}
