2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Object-Oriented Type Design]]

# C# Static Constant and Readonly Fields

A static field is shared by all instances of a type. A constant is substituted into calling code at compile time and must be expressible as a supported literal, while a readonly field is assigned at declaration or construction and remains a live field reference.

Readonly fields are safer for public values that may change between library versions because callers observe the field after recompilation of the library. Constants are appropriate only when the value is truly permanent and known at compile time.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
