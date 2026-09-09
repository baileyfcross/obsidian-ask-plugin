2026-09-08 21:16

Status: #baby

Tags: [[.NET Task Parallelism and Asynchrony]]

# C# Async and Await

An `async` method can use `await` to pause its logical execution until an awaitable operation completes. The method returns control to its caller instead of blocking the current thread and later resumes from the suspended point.

Asynchronous code improves responsiveness and scalability for waiting-heavy operations, but it does not make CPU work inherently faster. Tasks should normally be awaited, exceptions must be observed, and cancellation should be propagated through the operation graph.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
