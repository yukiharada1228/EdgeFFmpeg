# Packet queue ownership

`PacketQueue<T>` provides bounded, single-consumer delivery for the future media scheduler. Capacity counts both unpublished reservations and queued packets. Waiting reservations contain no packet payload and their count is also bounded. A producer must reserve a slot **before** reading or decoding the next packet, then publish the result or release the reservation if production fails.

Publishing transfers ownership to the queue. Successful consumption transfers it to the consumer, which must release any associated frame/buffer resources. The constructor's `discard` callback releases queued resources on cancellation or early exit from `for await`. The queue cannot release producer-owned unpublished resources; the producer must clean them up when publication fails. A reservation may publish once, and repeated release is harmless.

`close()` prevents new publications, revokes unpublished reservations and permits published packets to drain. `cancel(reason)` discards queued packets and rejects outstanding operations. An aborted signal also cancels a closed queue that is still draining. Cleanup attempts every queued item even when one disposer throws, then reports an AggregateError.

The scheduler must distribute `ResourceBudget.maxPendingPackets` among its queues and account for packets already handed to operators. Independent queue capacities alone do not establish a job-wide budget. This queue does not implement codec flushing, filter scheduling, state checkpoints or CPU-time enforcement.
