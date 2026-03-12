import { Controller, Delete, Get, Query } from '@nestjs/common';
import { AuthenticationRequired } from 'src/decorators/authentication.decorator';
import { BrowserPoolService } from 'src/services/browser-pool.service';

@AuthenticationRequired()
@Controller('/browser-pool')
export class BrowserPoolController {

  constructor(private readonly browser_pool_service: BrowserPoolService) { }

  @Get()
  getBrowserPool() {
    return this.browser_pool_service.status;
  }

  @Delete('/stale')
  async closeStaleInstances(@Query('max_age') max_age?: string) {
    const max_age_seconds = parseInt(max_age || '900', 10);
    const closed = await this.browser_pool_service.closeStaleInstances(max_age_seconds);
    return { closed, count: closed.length };
  }

}
