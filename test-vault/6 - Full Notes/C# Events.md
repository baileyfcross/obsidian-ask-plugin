2026-09-08 21:16

Status: #baby

Tags: [[C Sharp Interfaces Generics and Inheritance]]

# C# Events

A C# event lets one object publish that something happened while other objects subscribe handlers through delegates. The publisher raises the event without requiring knowledge of every subscriber, reducing direct coupling between participants.

The event boundary restricts outside code to subscription and unsubscription rather than arbitrary invocation. Event arguments carry details about the occurrence, and a custom event-argument type can add domain-specific data beyond the conventional sender reference.

# References

[[c80andnetcore30moderncross-platformdevelopment.pdf]]
