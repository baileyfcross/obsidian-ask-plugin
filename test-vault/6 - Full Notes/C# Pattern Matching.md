2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Operators Flow and Conversion]]

# C# Pattern Matching

C# pattern matching tests a value's type, shape, or value while optionally introducing a variable for the matched result. Type patterns can replace a separate type check and cast, and additional conditions can refine whether a case applies.

Patterns work in `if` statements and switch constructs. Ordering matters because a broad pattern can capture values before a narrower one is reached. A final discard pattern represents the remaining cases and makes the decision exhaustive.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
