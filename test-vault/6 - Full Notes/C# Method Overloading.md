2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Object-Oriented Type Design]]

# C# Method Overloading

Method overloading defines several members with the same name but different parameter signatures. The compiler selects an overload from the number, types, order, and passing modes of the arguments supplied at the call site.

Overloads present one conceptual operation across several input forms. They should preserve related meaning; unrelated behavior hidden under one name makes selection harder to understand. Return type alone cannot distinguish overloads because it is not part of the call's argument signature.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
