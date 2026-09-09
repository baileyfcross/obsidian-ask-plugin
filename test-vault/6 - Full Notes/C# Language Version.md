2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Language and Type Fundamentals]]

# C# Language Version

A C# project selects a language version through its compiler and project configuration. The target framework normally supplies a compatible default, while a `LangVersion` setting can request a specific installed version, the latest major version, the latest available version, or a preview.

Language and runtime versions are related but not identical. C# 8.0 features require a compiler that understands them, and some features also depend on framework types or runtime behavior. Pinning a version makes the project's syntax expectations explicit instead of inheriting whatever a future toolchain happens to choose.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
