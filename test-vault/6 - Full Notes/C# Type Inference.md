2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Language and Type Fundamentals]]

# C# Type Inference

The `var` keyword asks the C# compiler to infer a local variable's static type from its initializer. The resulting variable remains strongly typed; inference shortens the declaration but does not make the value dynamically typed.

Explicit types can better communicate intent when the initializer obscures what it returns. Inference is especially helpful with anonymous types and long generic names, where the compiler knows a precise type that cannot or need not be written directly.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
