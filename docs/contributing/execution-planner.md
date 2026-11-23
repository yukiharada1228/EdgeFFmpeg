# Execution planning foundation

`FeatureRegistry<T>` stores immutable plain metadata, keyed by a unique feature ID. It preserves the distinction between unknown, unimplemented and runtime-blocked features. Runtime support is explicit; an empty runtime list grants no support. Compatibility statuses `conformant` and `bitexact` require test references, but these references must still be checked by conformance tooling. Registration itself does not establish compatibility. Functions and mutable containers do not belong in this metadata registry.

`planGraph` accepts an already constructed, explicit single-worker graph and operator metadata. It resolves features, validates media pad types and connections, and returns an immutable topological order. Every required pad must be connected; optional pads may remain unconnected. Each input accepts one producer. A producer pad also permits only one consumer; splitting requires an operator with explicit separate output pads and a future implementation with defined ownership semantics.

The planner rejects cycles, unknown endpoints, duplicate node/pad IDs, incompatible pad types, invalid resource estimates, impossible resident-memory lower bounds and aggregate queue capacities above the packet budget. Minimum operator memory assumes all operator instances are resident simultaneously. CPU estimates and partial implementations are diagnostic warnings, not conformance evidence. Queue/frame memory and runtime overhead are not included in the declared memory lower bound.

Operator traits record statefulness, access pattern, checkpointability, temporal dependence, determinism, memory lower bounds and CPU estimates. These attributes are not yet sufficient to prove safe distribution, checkpoint serialization or bit-exact partitioning.

This is a structural planning primitive. CLI stream selection, format negotiation, filter parsing, codec resolution policy, distributed WorkUnits, executable operator factories and graph scheduling remain to be implemented. No production codecs or containers are registered by default. Test-only descriptors exercise planning without claiming media execution support.
