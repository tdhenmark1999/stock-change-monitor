import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { fieldInputSchema, fieldPatchSchema, monitorCreateSchema, monitorUpdateSchema, previewSchema } from '@esm/shared';
import { MonitorsService } from './monitors.service';

const id = () => new ParseUUIDPipe({ version: '4' });

@Controller('monitors')
export class MonitorsController {
  constructor(@Inject(MonitorsService) private readonly monitors: MonitorsService) {}

  @Get()
  list() {
    return this.monitors.list();
  }

  @Post()
  create(@Body() body: unknown) {
    return this.monitors.create(monitorCreateSchema.parse(body));
  }

  @Post('preview')
  @HttpCode(200)
  preview(@Body() body: unknown) {
    const { url, fields } = previewSchema.parse(body);
    return this.monitors.preview(url, fields);
  }

  @Get(':id')
  get(@Param('id', id()) monitorId: string) {
    return this.monitors.get(monitorId);
  }

  @Patch(':id')
  update(@Param('id', id()) monitorId: string, @Body() body: unknown) {
    return this.monitors.update(monitorId, monitorUpdateSchema.parse(body));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', id()) monitorId: string) {
    return this.monitors.remove(monitorId);
  }

  @Post(':id/check')
  @HttpCode(202)
  check(@Param('id', id()) monitorId: string) {
    return this.monitors.triggerCheck(monitorId);
  }

  @Post(':id/fields')
  addField(@Param('id', id()) monitorId: string, @Body() body: unknown) {
    return this.monitors.addField(monitorId, fieldInputSchema.parse(body));
  }

  @Patch(':id/fields/:fieldId')
  updateField(@Param('id', id()) monitorId: string, @Param('fieldId', id()) fieldId: string, @Body() body: unknown) {
    return this.monitors.updateField(monitorId, fieldId, fieldPatchSchema.parse(body));
  }

  @Delete(':id/fields/:fieldId')
  @HttpCode(204)
  removeField(@Param('id', id()) monitorId: string, @Param('fieldId', id()) fieldId: string) {
    return this.monitors.removeField(monitorId, fieldId);
  }
}
