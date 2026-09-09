2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Object-Oriented Type Design]]

# C# Enum Types

A C# enum defines a named set of integral constants. It replaces unexplained numeric values with domain vocabulary and constrains callers to a known family of choices such as states, categories, or modes.

An enum marked for flags assigns powers of two so several values can be combined in one bit field. Bitwise operations and `HasFlag` can then add, remove, or test individual choices without treating their combination as an unrelated number.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
