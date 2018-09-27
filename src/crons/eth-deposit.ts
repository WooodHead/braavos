import { Injectable } from '@nestjs/common';
import bunyan from 'bunyan';
import { Cron, NestSchedule } from 'nest-schedule';
import { ConfigService } from 'nestjs-config';
import Web3 from 'web3';
import { AmqpService } from '../amqp/amqp.service';
import { ChainEnum, EthereumService } from '../chains';
import { CoinEnum } from '../coins';
import { Addr } from '../entities/addr.entity';
import { Coin } from '../entities/coin.entity';
import { DepositStatus } from '../entities/deposit-status.enum';
import { Deposit } from '../entities/deposit.entity';

const { ETH } = CoinEnum;
const { ethereum } = ChainEnum;

@Injectable()
export class EthDeposit extends NestSchedule {
  private readonly web3: Web3;
  private readonly config: ConfigService;
  private readonly logger: bunyan;
  private readonly amqpService: AmqpService;
  private ethereumService: EthereumService;
  private cronLock: any;

  constructor(
    config: ConfigService,
    logger: bunyan,
    web3: Web3,
    amqpService: AmqpService,
    ethereumService: EthereumService,
  ) {
    super();
    this.config = config;
    this.logger = logger;
    this.web3 = web3;
    this.amqpService = amqpService;
    this.ethereumService = ethereumService;
    this.cronLock = {
      depositCron: false,
    };
  }

  @Cron('*/30 * * * * *', { startTime: new Date() })
  public async depositCron(): Promise<void> {
    try {
      if (this.cronLock.depositCron === true) {
        this.logger.warn('last depositCron still in handling');
        return;
      }
      this.cronLock.depositCron = true;
      const minimumThreshold: number = this.config.get(
        'ethereum.ether.deposit.minimumThreshold',
      );
      const pocketAddr: string = this.config.get(
        'ethereum.ether.deposit.pocketAddr',
      );
      const step: number = this.config.get('ethereum.ether.deposit.step');
      this.logger.debug(new Date());
      const coin = await Coin.createQueryBuilder()
        .where({ symbol: ETH })
        .getOne();
      if (!coin) {
        this.cronLock.depositCron = false;
        throw new Error();
      }
      /**
       * query blockIndex from db
       * @param blockIndex already handled block
       */
      let blockIndex = coin.info.cursor;
      // add 1 to be the first unhandled block
      blockIndex = blockIndex + 1;
      let height = await this.web3.eth.getBlockNumber();
      height = height - 3;
      if (height < blockIndex) {
        // logger.warn('Ethereum full node is lower than db');
        this.cronLock.depositCron = false;
        return;
      }
      height = Math.min(height, blockIndex + step - 1);
      // handle block
      for (; blockIndex <= height; blockIndex++) {
        // handle transactions
        const block = await this.web3.eth.getBlock(blockIndex, true);
        await Promise.all(
          block.transactions.map(async (tx) => {
            const receipt = await this.web3.eth.getTransactionReceipt(tx.hash);
            if (receipt.status === false) {
              return;
            }
            if (!tx.to) {
              /* tx.to is null, contract creation transaction, ignore it */
              return;
            }
            const user = await Addr.findOne({ addr: tx.to, chain: ethereum });
            if (!user) {
              return;
            }
            /* pocket address send ether to this address in order to pay erc20 transfer fee, ignore it */
            if (tx.from === pocketAddr) {
              return;
            }
            /* tiny deposit, ignore it */
            if (
              this.web3.utils
                .toBN(tx.value)
                .lt(this.web3.utils.toBN(minimumThreshold))
            ) {
              return;
            }
            const checkTx = await Deposit.findOne({
              coinSymbol: ETH,
              txHash: tx.hash,
            });
            if (!checkTx) {
              const amount = await this.web3.utils.fromWei(tx.value, 'ether');
              this.logger.debug(`
                blockHash: ${block.hash}
                blockNumber: ${block.number}
                txHash: ${tx.hash}
                amount: ${amount}
              `);
              const d = await Deposit.create({
                addrPath: user.path,
                amount: String(amount),
                clientId: user.clientId,
                coinSymbol: ETH,
                feeAmount: 0,
                feeSymbol: ETH,
                status: DepositStatus.unconfirmed,
                txHash: tx.hash,
              });
              d.info = {
                blockHash: block.hash,
                blockHeight: block.number,
                recipientAddr: tx.to,
                senderAddr: tx.from,
              };
              await d.save();
              await this.amqpService.createDeposit(d);
            } else {
              return;
            }
          }),
        );
        coin.info.cursor = blockIndex;
        await coin.save();
        this.logger.debug('blockIndex: ', blockIndex);
      }
      this.logger.debug('finish deposit this time');
      this.cronLock.depositCron = false;
    } catch (err) {
      this.logger.error(err);
      this.cronLock.depositCron = false;
    }
  }
}
