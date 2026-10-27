# Reference Mission

Primary v0.1 stress test:

> Produce a 45-minute high-production AI technology keynote with an editable presentation, speaker notes, supporting motion/media, and source record. The result should feel like a technical launch keynote rather than a conventional corporate deck and should use current reliable information.

Faults to inject during development:

- required motion capability missing
- first external capability candidate functionally fails
- user changes style/technical depth mid-mission
- deck output contains layout overflow
- a key evidence source becomes stale
- media integration fails
- runtime restarts during an active execution

Passing the reference mission must prove dynamic replanning and recovery. No code path may special-case `tech-keynote`.
