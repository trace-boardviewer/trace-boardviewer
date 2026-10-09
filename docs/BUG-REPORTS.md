# In-app bug reports

The report form is available from **Report a bug** in the title bar and from the support reminder. It works without a board open. The form asks for one description; technical diagnostics are optional and start enabled. Import context is captured when the form opens. Turning diagnostics off sends a null diagnostics value.

The review step is built from the main-process preview. It displays the exact canonical JSON and its SHA-256 and byte count. Editing either the description or diagnostics selection invalidates that preview. The optional privacy helper detects some common paths and credential-like text while you type; it can miss private details. Detection only shows a hint. Text changes only when you explicitly choose to remove the detected details, and you can review the result.

The desktop form offers an explicit Send action after review when the separate receiver and complete prepare/send/cancel bridge are available. Browser and older-bridge flows keep the text local and allow copying through an explicit action. The form can be closed without saving or deleting an unknown local journal; a warning keeps uncertain delivery status explicit. In the desktop app, saving a draft is optional; drafts and retry records stay on the device and expire after seven days. Nothing is sent automatically.

When the receiver is enabled, the disclosure describes the approved retention limits: report content up to 30 days, provider recovery history up to seven further days, and the temporary hashed abuse-control bucket up to 48 hours. Cleanup timing is best effort and hosting outages can delay deletion. The disclosure does not claim that those limits guarantee deletion at an exact time.

There are no attachments, email addresses, sign-in, clipboard reads, or automatic send attempts. A send attempt without a verified durable acknowledgement remains uncertain. Retry uses the same report identity and bytes; editing after an attempt creates a new report after another review.
