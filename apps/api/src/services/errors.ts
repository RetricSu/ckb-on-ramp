export class FundingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FundingPolicyError';
  }
}
