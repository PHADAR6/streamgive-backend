
export function startIndexer(pollOnce: () => Promise<void>, intervalMs: number) {
  let timeoutId: NodeJS.Timeout | null = null;
  let isStopped = false;
  let isPolling = false;

  const poll = async () => {
    if (isStopped) return;

    if (isPolling) {
      // Skip this tick if a poll is already in flight
      scheduleNext();
      return;
    }

    isPolling = true;
    try {
      await pollOnce();
    } catch (error) {
      console.error('Error during indexer poll:', error);
    } finally {
      isPolling = false;
      scheduleNext();
    }
  };

  const scheduleNext = () => {
    if (isStopped) return;
    timeoutId = setTimeout(poll, intervalMs);
  };

  // Kick off the initial poll
  poll();

  // Return stop function that cancels any pending timer
  return () => {
    isStopped = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}

export async function pollOnce(rpcClient: any, processEvent: (event: any) => Promise<void>) {
  let currentCursor = await getStoredCursor();
  const PAGE_LIMIT = 100; // Adjust according to your RPC client configuration
  let hasMore = true;

  while (hasMore) {
    const response = await rpcClient.getEvents({
      cursor: currentCursor,
      limit: PAGE_LIMIT,
    });

    const events = response.events || [];

    // Process each event in the current page sequentially
    for (const event of events) {
      await processEvent(event);
      currentCursor = event.id; // Update cursor to latest processed event
    }

    // If the page size is less than the limit, or no next cursor is provided, we've reached the end
    if (events.length < PAGE_LIMIT || !response.nextCursor) {
      hasMore = false;
    } else {
      currentCursor = response.nextCursor;
    }
  }
}