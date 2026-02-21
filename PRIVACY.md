# Privacy Policy – InstaClean

**Last updated:** February 21, 2026

## Overview

InstaClean is a browser extension that helps users manage their own Instagram activity (likes and comments). It operates entirely within the user's browser and does not collect, transmit, or store any personal data externally.

## Data Collection

**InstaClean does not collect any data.** Specifically:

- No personal information is collected
- No browsing history is tracked
- No analytics or telemetry is sent
- No cookies are read or created
- No data is transmitted to any server
- No third-party services are used

## Local Storage

InstaClean uses `chrome.storage.local` to store the following data **locally on your device only**:

| Data                         | Purpose                                               |
| ---------------------------- | ----------------------------------------------------- |
| Exclude friends toggle state | Remember your preference                              |
| Friends list (usernames)     | Skip interactions with friends during comment removal |
| Operation progress           | Resume operations after page navigation               |
| Panel state (open/minimized) | Remember UI position                                  |

This data never leaves your browser and is deleted when you uninstall the extension.

## How the Extension Works

InstaClean interacts exclusively with Instagram's web interface (`instagram.com`) by:

1. Navigating to your activity pages (likes/comments)
2. Reading the page DOM to identify your activity items
3. Clicking Instagram's native UI buttons (Select, Delete, Unlike) on your behalf

The extension does **not**:

- Access Instagram's API
- Read or store your Instagram credentials
- Access your direct messages, stories, or any private content
- Interact with other users' accounts
- Access any website other than `instagram.com`

## Permissions

| Permission                         | Reason                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| `activeTab`                        | Inject the control panel into the active Instagram tab     |
| `storage`                          | Save preferences and friends list locally                  |
| `scripting`                        | Load the content script when the extension icon is clicked |
| `host_permissions (instagram.com)` | Operate on Instagram activity pages                        |

## Changes to This Policy

If this privacy policy is updated, the changes will be reflected in this document with an updated date. No notification mechanism is required as no data is collected.

## Contact

For questions about this privacy policy, please open an issue on the project's GitHub repository.
