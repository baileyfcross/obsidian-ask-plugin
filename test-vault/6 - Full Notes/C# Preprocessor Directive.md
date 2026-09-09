2026-09-06 20:37

Status: #baby

Tags: [[Application Debugging]] [[C Sharp Language and Type Fundamentals]]

# C# Preprocessor Directive

A C# preprocessor directive controls which source sections participate in a compilation. A conditional `#if` block can include development-only diagnostic code when a symbol is defined and omit it from another build configuration.

This can isolate debugging helpers such as SQL query inspection from a production build. It is a compile-time boundary, not a runtime authorization check.

# References

[[aspnetcore3andangular9_3ed.pdf]]
[[c80andnetcore30moderncross-platformdevelopment.pdf]]
