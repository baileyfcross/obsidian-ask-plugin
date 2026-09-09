2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Operators Flow and Conversion]]

# C# Checked Arithmetic

Integer arithmetic can exceed a type's representable range and wrap to another value. A `checked` context converts that silent overflow into an exception, while `unchecked` explicitly permits the wraparound behavior.

The correct policy depends on the operation. Silent wrapping may be intentional in low-level algorithms, but business quantities and conversions usually need a detectable failure. Compiler settings can establish a default, and local checked or unchecked blocks can state exceptions to that policy.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
