using System.Collections.Concurrent;

namespace Relu.AI.Bridge.DesktopConnector.Internal;

/// <summary>
/// Tracks the actual lifetime of capability handlers. A timed-out request does not free its
/// slot until a cancellation-ignoring handler really exits.
/// </summary>
internal sealed class BoundedHandlerSlots
{
    private readonly SemaphoreSlim _slots;
    private readonly ConcurrentDictionary<string, byte> _requestIds = new(StringComparer.Ordinal);

    internal BoundedHandlerSlots(int capacity)
    {
        if (capacity < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(capacity));
        }
        _slots = new SemaphoreSlim(capacity, capacity);
    }

    internal int InUse => _requestIds.Count;

    internal bool Contains(string requestId) => _requestIds.ContainsKey(requestId);

    internal bool TryAcquire(string requestId)
    {
        if (!_slots.Wait(0))
        {
            return false;
        }
        if (_requestIds.TryAdd(requestId, 0))
        {
            return true;
        }
        _slots.Release();
        return false;
    }

    internal void ReleaseWhenCompleted(string requestId, Task handlerTask)
    {
        ArgumentNullException.ThrowIfNull(handlerTask);
        if (handlerTask.IsCompleted)
        {
            ObserveFault(handlerTask);
            Release(requestId);
            return;
        }
        _ = AwaitAndReleaseAsync(requestId, handlerTask);
    }

    private async Task AwaitAndReleaseAsync(string requestId, Task handlerTask)
    {
        try
        {
            await handlerTask.ConfigureAwait(false);
        }
        catch
        {
            // The bounded protocol response is owned by the caller. Observe only.
        }
        finally
        {
            Release(requestId);
        }
    }

    private void Release(string requestId)
    {
        if (!_requestIds.TryRemove(requestId, out _))
        {
            throw new InvalidOperationException("Desktop request slot was released more than once.");
        }
        _slots.Release();
    }

    private static void ObserveFault(Task handlerTask)
    {
        if (handlerTask.IsFaulted)
        {
            _ = handlerTask.Exception;
        }
    }
}
