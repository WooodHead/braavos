import { Injectable } from '@nestjs/common';
import bunyan from 'bunyan';
import { Cron, NestSchedule } from 'nest-schedule';
import { ConfigService } from 'nestjs-config';
import { getManager } from 'typeorm';
import Web3 from 'web3';
import { AmqpService } from '../amqp/amqp.service';
import { ChainEnum } from '../chains';
import { CoinEnum, EthService } from '../coins';
import { Account } from '../entities/account.entity';
import { DepositStatus } from '../entities/deposit-status.enum';
import { Deposit } from '../entities/deposit.entity';

const { ETH } = CoinEnum;
const { ethereum } = ChainEnum;

@Injectable()
export class EthConfirm extends NestSchedule {
  private readonly web3: Web3;
  private readonly config: ConfigService;
  private readonly logger: bunyan;
  private readonly amqpService: AmqpService;
  private ethereumService: EthService;
  private cronLock: any;

  constructor(
    config: ConfigService,
    logger: bunyan,
    web3: Web3,
    amqpService: AmqpService,
    ethereumService: EthService,
  ) {
    super();
    this.config = config;
    this.logger = logger;
    this.web3 = web3;
    this.amqpService = amqpService;
    this.ethereumService = ethereumService;
    this.cronLock = {
      confirmCron: false,
    };
  }

  @Cron('*/10 * * * * *', { startTime: new Date() })
  public async confirmCron(): Promise<void> {
    if (this.cronLock.confirmCron === true) {
      this.logger.warn('last confirmCron still in handling');
      return;
    }
    try {
      this.cronLock.confirmCron = true;
      const confThreshold: number = this.config.get(
        'ethereum.ether.collect.confThreshold',
      );
      const uu = await Deposit.createQueryBuilder()
        .select()
        .where({ coinSymbol: ETH, status: DepositStatus.unconfirmed })
        .orderBy('id')
        .getMany();
      if (uu.length <= 0) {
        this.cronLock.confirmCron = false;
        return;
      }
      const height = await this.web3.eth.getBlockNumber();
      await Promise.all(
        uu.map(async (tx: Deposit) => {
          const blockHeight = tx.info.blockHeight;
          if (height - blockHeight < confThreshold) {
            return;
          }
          const acc = await Account.createQueryBuilder()
            .select()
            .where({ clientId: tx.clientId, coinSymbol: ETH })
            .getOne();
          if (!acc) {
            this.logger.error(`don't have this account`);
            return;
          }
          await getManager().transaction(async (manager) => {
            await manager
              .createQueryBuilder()
              .update(Deposit)
              .set({ status: DepositStatus.confirmed })
              .where({ id: tx.id })
              .execute();
            await manager
              .createQueryBuilder()
              .insert()
              .into(Account)
              .values({ clientId: tx.clientId, coinSymbol: ETH })
              .onConflict('("clientId", "coinSymbol") DO NOTHING')
              .execute();
            await manager
              .createQueryBuilder(Account, 'account')
              .where({ clientId: tx.clientId, coinSymbol: ETH })
              .setLock('pessimistic_write')
              .getOne();
            await manager.increment(
              Account,
              { clientId: tx.clientId, coinSymbol: ETH },
              'balance',
              Number(tx.amount),
            );
            this.logger.debug(`confirm tx: ${tx.id}`);
          });
          const d = await Deposit.findOne({ id: tx.id });
          if (d && d.status === DepositStatus.confirmed) {
            await this.amqpService.updateDeposit(d);
          }
        }),
      );
      this.cronLock.confirmCron = false;
    } catch (err) {
      this.logger.error(err);
      this.cronLock.confirmCron = false;
    }
  }
}
