# For After — Incident Response

## 1. Severity Levels

| Level | Name | Description | Examples |
|---|---|---|---|
| **P1** | Critical | Widespread system failure, data breach, or critical workflow failure. | Complete service outage, Death verification system failure, Data breach. |
| **P2** | High | Important functionality is broken for many users. | Message delivery failures, Payment errors, Auth system issues. |
| **P3** | Medium | Feature degradation or localized issues. | Slow performance, non-critical background jobs failing. |
| **P4** | Low | Minor issues that don't block workflows. | UI bugs, typos, minor non-blocking errors. |

## 2. Response Procedures
1. **Detection**: Issue identified via alerts, user reports, or monitoring.
2. **Triage**: Assign severity level and designate an Incident Commander.
3. **Containment**: Stop the bleeding (e.g., disable feature, block IPs).
4. **Resolution**: Deploy fix and verify functionality.
5. **Post-mortem**: Write an incident report outlining root cause and preventative measures.

## 3. Delivery Failure Handling
- **Automated Retries**: BullMQ handles exponential backoff retries.
- **Dead Letter Queue (DLQ)**: Permanently failed jobs go to the DLQ.
- **Alerting**: Admin alerts are triggered via Sentry and Slack for DLQ insertions.
- **Manual Intervention**: Admins can manually retry failed jobs from the dashboard.
- **Safeguards**: PostgreSQL delivery status tracking prevents duplicate sends if a job is retried.

## 4. Death Verification Incident Handling
- **False Positive Recovery**: If a death is wrongly approved, a strict recovery procedure must be initiated immediately to revoke access, disable links, and notify affected parties.
- **Evidence Tampering**: Detection protocols flag suspicious metadata on uploaded documents.
- **Auditing**: Detailed admin audit trails are available for all status changes.

## 5. Data Breach Response
- **Containment**: Immediate invalidation of all user sessions.
- **Remediation**: Forced password resets for affected or all users.
- **Notification**: Communication dispatched to affected users.
- **Compliance**: Notifying regulatory bodies (e.g., OAIC in Australia) within mandatory timeframes if PII is exposed.

## 6. Monitoring & Alerts
- **Sentry**: Tracks application errors and unhandled exceptions.
- **BullMQ**: Alerts on failed job count thresholds.
- **Database**: Monitors connection pool exhaustion, query latency, and disk usage.
- **Redis**: Monitors memory usage, eviction rates, and connection drops.
- **Storage**: Alerts on approaching bucket quotas or unexpected usage spikes.

## 7. Backup & Recovery
- **Database**: PostgreSQL uses Point-in-Time Recovery (PITR) for granular rollback.
- **Media Storage**: S3 versioning protects against malicious or accidental object deletion.
- **RPO/RTO**: Defined Recovery Point Objective and Recovery Time Objective targets are reviewed quarterly.

## 8. Contact & Escalation
- An on-call rotation ensures 24/7 coverage.
- Escalation paths define exactly when to pull in senior engineering or executive leadership based on the severity level (e.g., P1 mandates immediate executive notification).
