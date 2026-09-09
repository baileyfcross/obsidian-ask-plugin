2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Functions Diagnostics and Testing]]

# C# Recursive Functions

A recursive function solves a problem by calling itself with a smaller or simpler input. It requires a base case that returns without another call and a recursive case that makes progress toward that base.

Each call consumes stack space until it returns, so missing or unreachable termination can cause a stack overflow. Recursive definitions can closely match problems such as factorials, but their numeric result can still overflow the chosen return type even when the recursion itself terminates correctly.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
