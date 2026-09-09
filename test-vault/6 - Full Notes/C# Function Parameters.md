2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Functions Diagnostics and Testing]]

# C# Function Parameters

Parameters define the typed inputs a C# function accepts, while arguments are the values supplied at a call site. A parameter can receive a value normally, copy data out through `out`, accept input by reference with `ref`, or receive a read-only reference through `in`.

Passing mode affects whether assignments inside the function can change the caller's variable. Clear names and narrow types communicate the contract, and validation near the function boundary prevents an invalid argument from producing a failure far from its source.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
