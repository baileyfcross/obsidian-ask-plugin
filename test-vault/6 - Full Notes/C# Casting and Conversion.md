2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Operators Flow and Conversion]]

# C# Casting and Conversion

Implicit conversion occurs when C# can move a value to another type without expected information loss. Explicit casting is required when the destination has a smaller range or a value may not belong to that type, making the risk visible in source code.

The `Convert` class supplies conversions whose behavior can differ from a direct cast, particularly around rounding and supported representations. Conversion is not merely a syntax problem: the program must decide what loss, rounding, overflow, or invalid input means in its domain.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
