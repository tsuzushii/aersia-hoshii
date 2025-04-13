/**
 * A simple token bucket rate limiter
 */
export interface RateLimiterOptions {
    tokensPerInterval: number;
    interval: number; // in milliseconds
    maxTokens?: number;
  }
  
  export class RateLimiter {
    private tokens: number;
    private lastRefill: number;
    private tokensPerInterval: number;
    private interval: number;
    private maxTokens: number;
    
    constructor(options: RateLimiterOptions) {
      this.tokensPerInterval = options.tokensPerInterval;
      this.interval = options.interval;
      this.maxTokens = options.maxTokens || options.tokensPerInterval;
      this.tokens = this.maxTokens;
      this.lastRefill = Date.now();
    }
  
    /**
     * Refill the token bucket based on elapsed time
     */
    private refill(): void {
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      
      if (elapsed < 0) {
        // Clock might have been adjusted, reset
        this.lastRefill = now;
        return;
      }
      
      // Calculate tokens to add based on elapsed time
      const tokensToAdd = Math.floor(elapsed / this.interval * this.tokensPerInterval);
      
      if (tokensToAdd > 0) {
        this.tokens = Math.min(this.tokens + tokensToAdd, this.maxTokens);
        this.lastRefill = now;
      }
    }
  
    /**
     * Get the number of tokens currently available
     */
    public getTokensRemaining(): number {
      this.refill();
      return this.tokens;
    }
  
    /**
     * Check if tokens can be consumed without actually consuming them
     */
    public tryRemoveTokens(count: number): boolean {
      this.refill();
      return this.tokens >= count;
    }
  
    /**
     * Remove tokens from the bucket, will wait if not enough tokens
     * Returns a promise that resolves when tokens are consumed
     */
    public async removeTokens(count: number): Promise<void> {
      // Validate count
      if (count > this.maxTokens) {
        throw new Error(`Requested tokens ${count} exceeds maximum tokens ${this.maxTokens}`);
      }
      
      // Refill and check
      this.refill();
      
      if (this.tokens >= count) {
        // We have enough tokens, consume them immediately
        this.tokens -= count;
        return;
      }
      
      // Not enough tokens, wait for refill
      return new Promise<void>((resolve) => {
        const checkAndConsume = () => {
          this.refill();
          
          if (this.tokens >= count) {
            this.tokens -= count;
            resolve();
          } else {
            // Calculate time until next token is available
            const tokensNeeded = count - this.tokens;
            const timePerToken = this.interval / this.tokensPerInterval;
            const waitTime = Math.ceil(tokensNeeded * timePerToken);
            
            // Wait and check again
            setTimeout(checkAndConsume, waitTime);
          }
        };
        
        checkAndConsume();
      });
    }
  }