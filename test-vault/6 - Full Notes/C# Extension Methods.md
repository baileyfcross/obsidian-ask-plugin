2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Interfaces Generics and Inheritance]]

# C# Extension Methods

An extension method is a static method that can be called with instance-style syntax on another type. Its first parameter uses `this` to identify the extended type, and importing the declaring namespace makes the method available to callers.

Extension methods add reusable operations when a type cannot or should not be inherited, including sealed framework types such as strings. They do not modify the original type or gain access to its private state; they remain ordinary static functions with convenient call syntax.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
