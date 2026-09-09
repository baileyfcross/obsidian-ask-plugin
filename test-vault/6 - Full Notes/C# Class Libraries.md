2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Object-Oriented Type Design]]

# C# Class Libraries

A C# class library packages reusable types without defining a standalone application entry point. Another project references its assembly and imports its namespaces before using its public classes and members.

Separating shared types from a console, web, or graphical application gives the library an independent build boundary. It also makes dependencies explicit and allows several application models to use the same domain logic without copying source files.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
