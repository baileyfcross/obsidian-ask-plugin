2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Object-Oriented Type Design]]

# C# Constructors

A constructor runs when a C# object is created and establishes its valid initial state. It has the type's name, has no return type, and can accept parameters that supply values required by the new instance.

Several constructors can be overloaded for different initialization paths, and one can delegate to another to centralize shared work. Construction is a useful invariant boundary: an object should not leave it missing values that every later method assumes exist.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
