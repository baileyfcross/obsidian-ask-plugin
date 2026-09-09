2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Object-Oriented Type Design]]

# C# Tuple Returns and Deconstruction

C# tuple syntax groups several values into one lightweight result. Naming tuple elements replaces generic positional names with domain meaning, and inferred names can carry suitable local identifiers into the tuple.

Deconstruction assigns the elements into separate variables in one statement, while discards ignore values the caller does not need. Tuples suit local combinations with little behavior; a dedicated type is clearer when the group needs validation, methods, or a stable public contract.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
