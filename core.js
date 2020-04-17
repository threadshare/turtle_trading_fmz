/**
 海龟策略v1.1
 用途：分散风险,平抑波动,波动套利  结合反海龟策略食用来做风险对冲 效果更佳
 2019/11/9  retrySell后加sleep，解决清仓余额不足的问题
 2019/11/10  fixed Sell(-1, 0.00033): Less than minimum requirement
 2019/11/10 fixed 无限仓位问题
 2019/11/17 符合海龟交易法则 (ATR真实波幅均值调优, 唐安奇通道参数调优)
 2019/11/17 修改清仓时不更新account.stock的问题
 2019/12/17 retrysell函数支持 对最小数量的自动修正
 2019/12/15 支持utc+8时间和logprofit
 2019/12/15 支持对象化和管理多个交易对
 2019/12/24 支持统计手续费损失
 2020/2/2 retryBuy支持自动修正买入量
 2019/2/23 支持统计市价单盈亏
 2020/3/8 支持收益曲线连续
 2020/4/12 增加 RSI 震荡指标
 2020/4/17 改进代码结构 完善资产风险控制逻辑
 */

/**
 使用说明
 1. 此策略基于 发明者平台 实现，在使用之前需要有一个 发明者 账户
 2. 上传策略并创建机器人
 3. 配置参数并运行策略
 */

/**
 * v1.2 版本
 * todo 优化点
 * 1.优化交易手续费 通过接口去获取
 * 2.优化 RSI相对强弱 信号对仓位进行操作
 * 3.添加 BOLL指标 与唐安奇通道 diff,  增强信号判断
 * 4.研究 CCI价格浮标 指标在类海龟策略中结合的可能性
 * 5.继续增加盈亏止损算法  降低风险
 * 6.结合反海龟策略 在模拟盘上回测 比较对冲收益
 */

/**
 *      参数说明
 *      1. ResetData bool robot 重启是否清除所有日志
 *      2. PricePrecision number 下单价格小数点精度
 *      3. AmountPrecision number 下单数量小数精度
 *      4. MinBuyStock number 下单最小买入量
 *      5. MinSellStock number 下单最小卖出量
 *      6. OrderWaitMS number 订单最长等待时间(ms) 推荐: 120000
 *      7. WaitMS number 等待时长(ms) 推荐默认: 1000
 *      8. RetryTimes number 重试下单次数 推荐:3 次  防止价格变动过快 无限重试下单  但是价格有问题  如果填入的是-1  无限重试
 *      9. SXF folat 手续费
 *      10. MaxPositions number 最大仓位操作记录 默认 4
 */


/**
 * 一些工具函数
 */


function CustomLog(msg, color = '', broadcast = false) {
    if (color.length > 0) {
        msg += " ";
        msg += color;
    }

    if (broadcast) {
        msg += "@";
    }

    Log(msg);
}

function CustomWarning(msg, broadcast = false) {
    CustomLog(msg, "#ff0000", broadcast);
}

//重写机器人生命周期异常退出函数, 添加一些自定义化的错误上去
function onerror() {
    CustomWarning("程序遇到严重错误, 为避免资产损失, 异常退出. 请及时检查!", true);
}

//处理入参
function checkParams() {
    //默认不清除之前的日志
    if (typeof (ResetData) === 'undefined') {
        ResetData = false;
    }
    //价格精度
    if (typeof (PricePrecision) === 'undefined') {
        PricePrecision = 8;
    }
    //数量精度
    if (typeof (AmountPrecision) === 'undefined') {
        AmountPrecision = 8;
    }
    //最小买的数量
    if (typeof (MinBuyStock) === 'undefined') {
        MinBuyStock = 0.01;
    }
    //最小卖的数量
    if (typeof (MinSellStock) === 'undefined') {
        MinSellStock = 0.01;
    }
    //订单等待时间
    if (typeof (OrderWaitMS) === 'undefined') {
        OrderWaitMS = 120000;
    }
    //等待毫秒数定义
    if (typeof (WaitMS) === 'undefined') {
        WaitMS = 1000;
    }
    //买卖失败重试次数
    if (typeof (RetryTimes) === 'undefined') {
        RetryTimes = 3;
    }
    //管理资产
    if (typeof (ManageAssets) === 'undefined') {
        ManageAssets = 1;
    }
    //手续费设置
    if (typeof (SXF) === 'undefined') {
        SXF = 0.0005;
    }
    //最大仓位操作记录
    if (typeof (MaxPositions) === 'undefined') {
        MaxPositions = 4;
    }
}

/**
 * 海龟核心算法
 * @type {{createNew: (function(*=): {})}}
 */
var ExchangProcessor = {
    createNew: function (exc_obj) {

        //全局状态变量
        var positions = [];//记录仓位
        var init_asset = 0; //初始资产
        var trades = [];//所有交易
        var trades_recorder = true;//记录所有交易
        var pre_time = null; //记录轮询间隔时间
        var approximate_profit = 0;//盈亏近似值
        var add_already = 0;//已经加仓次数

        var processor = {};

        /**
         * 重试购买，直到成功返回
         * @param ex 交易所对象
         * @param price 下单价格
         * @param num 下单数量
         * @returns {string}
         */
        processor.retryBuy = function (ex, price, num) {
            let currency = _C(ex.GetCurrency);
            //如果 1s 内获取不到货币对名称,证明交易所服务有问题 放弃这次操作
            if (currency.length === 0) {
                CustomWarning("获取货币对失败,本次下单失败. 请检查相关交易所 API 接口", true);
                return;
            }
            let r = ex.Buy(_N(price, PricePrecision), _N(num, AmountPrecision));
            let count = 0;
            while (!r) {
                //设置重试次数之后, 当达到重试的范围之后自动退出
                if ((RetryTimes !== -1) && (count >= RetryTimes)) {
                    break;
                }

                Log("Buy失败，正在retry。");
                Sleep(WaitMS);
                let account = _C(ex.GetAccount);
                let ticker = _C(ex.GetTicker);
                let last = ticker.Last;
                //确保可购买数量 在一个合理的范围, 也确保价格入参正常
                if (price === -1) {
                    CustomWarning("重试购买价格(-1)异常,请及时关注.", true);
                }
                let fixedAmount = (price === -1 ? Math.min(account.Balance * 0.95, num) : Math.min(account.Balance / last * 0.95, num));
                r = ex.Buy(_N(price, PricePrecision), _N(fixedAmount, AmountPrecision));
                count = count + 1;
            }
            return r;
        };

        /**
         * 重试卖出，直到成功返回
         * @param ex 交易所对象
         * @param price 卖出价格
         * @param num 卖出数量
         * @returns {string}
         */
        processor.retrySell = function (ex, price, num) {
            var currency = _C(ex.GetCurrency);
            //如果 1s 内获取不到货币对名称,证明交易所服务有问题 放弃这次操作
            if (currency.length === 0) {
                CustomWarning("获取货币对失败,本次卖出失败. 请检查相关交易所 API 接口", true);
                return;
            }
            var r = ex.Sell(_N(price, PricePrecision), _N(num, AmountPrecision));
            let count = 0;
            while (!r) {
                //设置重试次数之后, 当达到重试的范围之后自动退出
                if ((RetryTimes !== -1) && (count >= RetryTimes)) {
                    break;
                }
                Log("Sell失败，正在retry。");
                Sleep(WaitMS);
                var account = _C(ex.GetAccount);
                var fixedAmount = Math.min(account.Stocks, num);
                r = ex.Sell(_N(price, PricePrecision), _N(fixedAmount, AmountPrecision));
                count = count + 1;
            }
            return r;
        };


        /**
         * 获取当前国内时间字符串
         * @returns {string}
         */
        processor.get_ChinaTimeString = function () {
            var date = new Date();
            var now_utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
                date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
            var cdate = new Date(now_utc);
            cdate.setHours(cdate.getHours() + 8);
            var localstring = cdate.getFullYear() + '/' + (cdate.getMonth() + 1) + '/' + cdate.getDate() + ' ' + cdate.getHours() + ':' + cdate.getMinutes() + ':' + cdate.getSeconds();
            return localstring;
        };

        /**
         * 初始化构造
         */
        processor.init_obj = function () {
            _CDelay(WaitMS);
            pre_time = new Date();

            {
                var account = _C(exc_obj.GetAccount);
                var ticker = _C(exc_obj.GetTicker);
                if (!account || !ticker) {
                    CustomWarning("获取基本数据失败, 检查 API.", true);
                    throw "程序异常";
                }
                var last = ticker.Last;
                //计算账户有的总的 asset
                init_asset = (account.Balance + account.FrozenBalance) + (account.Stocks + account.FrozenStocks) * last;
                Sleep(WaitMS);
            }
        };


        /**
         * 计算逻辑
         * TODO: 之后可以优化成状态树的方式来写逻辑 现在这种 if 的形式会使代码看着很乱
         */
        processor.work = function () {
            var cur_time = new Date();
            var passedtime = cur_time - pre_time;
            pre_time = cur_time;

            //计算n,头寸
            var exname = _C(exc_obj.GetName);
            var currency = _C(exc_obj.GetCurrency);
            var account = _C(exc_obj.GetAccount);
            var ticker = _C(exc_obj.GetTicker);
            var depth = _C(exc_obj.GetDepth);
            if (!exname || !currency || !account || !ticker || !depth) {
                CustomWarning("work程序异常", true);
                return;
            }
            var last = ticker.Last;
            var ask1 = depth.Asks[0].Price;
            var bid1 = depth.Bids[0].Price;
            var bestprice = bid1 + (Math.abs(ask1 - bid1) / 2);
            var records = _C(exc_obj.GetRecords);
            if (records.length <= 50) {
                Log("records.length is not valid.");
                Sleep(WaitMS);
                return;
            }
            var atr = TA.ATR(records, 20);
            if (atr.length <= 1) {
                Log("atr.length is not valid.");
                Sleep(WaitMS);
                return;
            }
            var N = atr[atr.length - 1];
            var position_unit = Math.min(ManageAssets * 0.01 / N, account.Balance / last * 0.95);//cet
            //Log("N="+N+",  头寸单位="+position_unit+"CET");
            var highest = TA.Highest(records, 20, 'High');
            var Lowest = TA.Lowest(records, 10, 'Low');
            var cur_asset = (account.Balance + account.FrozenBalance) + (account.Stocks + account.FrozenStocks) * last;
            var rsi6 = TA.RSI(records, 6);
            var rsi12 = TA.RSI(records, 12);
            if (rsi6.length <= 5 || rsi12.length <= 5) {
                Log("rsi is not valid.");
                Sleep(WaitMS);
                return;
            }
            //震荡指标来判断
            var rsi_in = false;
            if (rsi6[rsi6.length - 1] - rsi6[rsi6.length - 2] > 5 &&
                rsi6[rsi6.length - 3] - rsi6[rsi6.length - 2] > 5 &&
                rsi6[rsi6.length - 2] <= 55 &&
                rsi6[rsi6.length - 1] > rsi12[rsi12.length - 1]) {
                Log("rsi_in=true");
                rsi_in = true;
            }
            var rsi_out = false;
            if (rsi6[rsi6.length - 2] - rsi6[rsi6.length - 1] > 5 &&
                rsi6[rsi6.length - 2] >= 70) {
                Log("rsi_out=true");
                rsi_out = true;
            }

            //建仓
            if (positions.length == 0 && position_unit > MinBuyStock) {
                if (last >= highest) {
                    var buyID = processor.retryBuy(exc_obj, last, position_unit);
                    Sleep(OrderWaitMS);
                    var buyOrder = _C(exc_obj.GetOrder, buyID);
                    if (buyOrder.Status != ORDER_STATE_CLOSED) {
                        _C(exc_obj.CancelOrder, buyID);
                    }
                    if (buyOrder.DealAmount > 0) {
                        //防止有的交易所没有均价字段, 取用下单价加手续费为均价
                        if (buyOrder.AvgPrice === 0) {
                            buyOrder.AvgPrice = buyOrder.Price * (1 + SXF)
                        }
                        var postion = {
                            amount: buyOrder.DealAmount,
                            buy_price: buyOrder.AvgPrice,
                            stoploss_price: buyOrder.AvgPrice - 2 * N
                        };
                        positions.push(postion);

                        var details = {
                            type: "建仓",
                            time: processor.get_ChinaTimeString(),
                            RealAmount: buyOrder.DealAmount,
                            WantAmount: position_unit,
                            RealPrice: buyOrder.AvgPrice,
                            WantPrice: buyOrder.Price,
                            Memo: ""
                        };
                        if (trades_recorder) {
                            trades.push(details);
                        }

                        add_already = 1;
                    }
                }
            }

            //加仓
            if (positions.length > 0 && position_unit > MinBuyStock) {
                var last_buy_price = positions[positions.length - 1].buy_price;
                if (add_already < MaxPositions) {//max = 4N
                    if (last - last_buy_price >= 0.5 * N) {
                        var buyID = processor.retryBuy(exc_obj, last, position_unit);
                        Sleep(OrderWaitMS);
                        var buyOrder = _C(exc_obj.GetOrder, buyID);
                        if (buyOrder.Status != ORDER_STATE_CLOSED) {
                            _C(exc_obj.CancelOrder, buyID);

                        }
                        if (buyOrder.DealAmount > 0) {
                            //防止有的交易所没有均价字段, 取用下单价加手续费为均价
                            if (buyOrder.AvgPrice === 0) {
                                buyOrder.AvgPrice = buyOrder.Price * (1 + SXF)
                            }
                            var postion = {
                                amount: buyOrder.DealAmount,
                                buy_price: buyOrder.AvgPrice,
                                stoploss_price: buyOrder.AvgPrice - 2 * N
                            };
                            positions.push(postion);

                            var details = {
                                type: "加仓",
                                time: processor.get_ChinaTimeString(),
                                RealAmount: buyOrder.DealAmount,
                                WantAmount: position_unit,
                                RealPrice: buyOrder.AvgPrice,
                                WantPrice: last,
                                Memo: ""
                            };
                            if (trades_recorder) {
                                trades.push(details);
                            }

                            add_already = add_already + 1;
                        }
                    }
                }
            }

            //止损
            if (positions.length > 0) {
                var positions_new = [];
                for (var i = 0; i < positions.length; i++) {
                    if (last <= positions[i].stoploss_price) {
                        account = _C(exc_obj.GetAccount);
                        var fixedAmount = Math.min(account.Stocks, positions[i].amount);
                        if (fixedAmount > MinSellStock) {
                            var sellID = processor.retrySell(exc_obj, last, fixedAmount);
                            Sleep(OrderWaitMS);
                            var sellOrder = _C(exc_obj.GetOrder, sellID);
                            approximate_profit += (sellOrder.AvgPrice * sellOrder.DealAmount * (1 - SXF) - positions[i].buy_price * sellOrder.DealAmount * (1 + SXF));
                            Log("定价卖出: 数量-" + sellOrder.DealAmount + ",approximate_profit=" + approximate_profit);
                            if (sellOrder.Status != ORDER_STATE_CLOSED) {
                                exc_obj.CancelOrder(sellID);
                                if (Math.min(account.Stocks, fixedAmount - sellOrder.DealAmount) > MinSellStock) {
                                    var marketsellOrderID = processor.retrySell(exc_obj, -1, fixedAmount - sellOrder.DealAmount);
                                    Sleep(OrderWaitMS);
                                    var marketsellOrderData = _C(exc_obj.GetOrder, marketsellOrderID);
                                    approximate_profit += (marketsellOrderData.AvgPrice * marketsellOrderData.DealAmount * (1 - SXF) - positions[i].buy_price * marketsellOrderData.DealAmount * (1 + SXF));
                                    Log("市价卖出: 数量-" + marketsellOrderData.DealAmount + ",approximate_profit=" + approximate_profit);
                                }
                            }

                            var details = {
                                type: "止损",
                                time: processor.get_ChinaTimeString(),
                                RealAmount: -1,
                                WantAmount: fixedAmount,
                                RealPrice: -1,
                                WantPrice: last,
                                Memo: (last > positions[i].buy_price ? "盈利" : "亏损")
                            };
                            if (trades_recorder) {
                                trades.push(details);
                            }
                        }
                    } else {
                        positions_new.push(positions[i]);
                    }
                }
                positions = positions_new;
            }

            //清仓
            if (positions.length > 0) {
                if (last <= Lowest) {
                    var positions_new = [];
                    for (var i = 0; i < positions.length; i++) {
                        account = _C(exc_obj.GetAccount);
                        var fixedAmount = Math.min(account.Stocks, positions[i].amount);
                        if (fixedAmount > MinSellStock) {
                            var sellID = processor.retrySell(exc_obj, last, fixedAmount);
                            Sleep(OrderWaitMS);
                            var sellOrder = _C(exc_obj.GetOrder, sellID);
                            approximate_profit += (sellOrder.AvgPrice * sellOrder.DealAmount * (1 - SXF) - positions[i].buy_price * sellOrder.DealAmount * (1 + SXF));
                            Log("定价卖出: 数量-" + sellOrder.DealAmount + ",approximate_profit=" + approximate_profit);
                            if (sellOrder.Status != ORDER_STATE_CLOSED) {
                                exc_obj.CancelOrder(sellID);
                                if (Math.min(account.Stocks, fixedAmount - sellOrder.DealAmount) > MinSellStock) {
                                    var marketsellOrderID = processor.retrySell(exc_obj, -1, fixedAmount - sellOrder.DealAmount);
                                    Sleep(OrderWaitMS);
                                    var marketsellOrderData = _C(exc_obj.GetOrder, marketsellOrderID);
                                    approximate_profit += (marketsellOrderData.AvgPrice * marketsellOrderData.DealAmount * (1 - SXF) - positions[i].buy_price * marketsellOrderData.DealAmount * (1 + SXF));
                                    Log("市价卖出: 数量-" + marketsellOrderData.DealAmount + ",approximate_profit=" + approximate_profit);
                                }
                            }

                            var details = {
                                type: "清仓",
                                time: processor.get_ChinaTimeString(),
                                RealAmount: -1,
                                WantAmount: fixedAmount,
                                RealPrice: -1,
                                WantPrice: last,
                                Memo: (last > positions[i].buy_price ? "盈利" : "亏损")
                            };
                            if (trades_recorder) {
                                trades.push(details);
                            }
                        }
                    }
                    positions = positions_new;
                }
            }


            //显示状态
            var table1 = {
                type: 'table',
                title: '仓位-' + exname + '(' + currency + ')',
                cols: ['数量', '成交价', '止损价'],
                rows: []
            };
            var table2 = {
                type: 'table',
                title: '状态-' + exname + '(' + currency + ')',
                cols: ['平均真实波幅(N)', '头寸单位', '初始资产', '当前资产', '轮询时间', '最新价', 'Highest', 'Lowest', '加仓次数', '【近似盈亏】'],
                rows: []
            };
            var table3 = {
                type: 'table',
                title: '交易历史-' + exname + '(' + currency + ')',
                cols: ['日期', '类型', '成交数量', '发单数量', '成交价', '发单价', '备注'],
                rows: []
            };
            for (var i = 0; i < positions.length; i++) {
                table1.rows.push([positions[i].amount, positions[i].buy_price, positions[i].stoploss_price]);
            }
            table2.rows.push([N, position_unit, init_asset, cur_asset, passedtime + 'ms', last, highest, Lowest, add_already, approximate_profit]);
            for (i = 0; i < trades.length; i++) {
                table3.rows.push([trades[i].time, trades[i].type, trades[i].RealAmount, trades[i].WantAmount, trades[i].RealPrice, trades[i].WantPrice, trades[i].Memo]);
            }
            processor.logstatus = ('`' + JSON.stringify([table1, table2, table3]) + '`' + '\n');

            //记录盈利
            processor.logprofit = approximate_profit;

            //rest
            Sleep(WaitMS);
        };

        return processor;
    }
};

function opOldLog() {
    //启动是是否清除所有日志
    if (ResetData) {
        LogProfitReset();
        LogReset();
    }
}

/**
 * 主函数
 * 界面策略参数:
 *      1. ResetData bool robot 重启是否清除所有日志
 *      2. PricePrecision number 下单价格小数点精度
 *      3. AmountPrecision number 下单数量小数精度
 *      4. MinBuyStock number 下单最小买入量
 *      5. MinSellStock number 下单最小卖出量
 *      6. OrderWaitMS number 订单最长等待时间(ms) 推荐: 120000
 *      7. WaitMS number 等待时长(ms) 推荐默认: 1000
 *      8. ManageAssets number 管理资产 默认 1
 *      9. SXF float 手续费 默认 0.5%
 */
function main() {
    opOldLog();

    //处理默认参数
    checkParams();
    var exchange_num = exchanges.length;
    var processors = [];
    for (var i = 0; i < exchange_num; ++i) {
        var p = ExchangProcessor.createNew(exchanges[i]);
        processors.push(p);
    }
    for (i = 0; i < exchange_num; ++i) {
        processors[i].init_obj();
    }
    var pre_profit = Number(_G("pre_profit"));
    Log('之前收入累计：' + pre_profit);
    var lastprofit = 0;

    while (true) {
        var allstatus = '实盘风险自担。#0000ff' + '\n';
        var allprofit = 0;
        for (i = 0; i < exchange_num; ++i) {
            processors[i].work();
            allstatus += processors[i].logstatus;
            allprofit += processors[i].logprofit;
        }

        allstatus += ('邮件：master@io404.net' + '\n');
        LogStatus(allstatus);
        if (lastprofit !== allprofit) {
            LogProfit(pre_profit + allprofit);
            _G("pre_profit", pre_profit + allprofit);
            lastprofit = allprofit;
        }
    }
}